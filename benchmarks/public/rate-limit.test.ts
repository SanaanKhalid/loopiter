import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitDelayMs } from "../../examples/prompt-improvement/provider.js";
import type { HotpotExample, Paragraph } from "../hotpotqa/fixtures.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { ifbenchTask } from "../ifbench/task.js";
import type { IfExample } from "../ifbench/fixtures.js";
import {
  LiveLedger,
  LiveSession,
  createStallWatchdog,
  rateLimitBudgetMs,
  DEFAULT_RATE_LIMIT_BUDGET_MS,
} from "../kb-qa/live.js";
import { planTask } from "./estimate.js";
import { PRODUCT_MINIMUM_IMPROVEMENT } from "./constants.js";
import { PREDICT_NAME, PROPOSE_INSTRUCTIONS, PROPOSE_NAME } from "./instructions.js";
import { resolveLimits } from "./limits.js";
import { requestBody } from "./bodies.js";
import { runController } from "./loop.js";
import { PROPOSE_BYTE_BUDGET, PROPOSE_EXAMPLE_CAP } from "./propose-bound.js";
import { buildSeededSplit } from "./splits.js";

test("retry hints and full jitter stay inside the per-wait cap", () => {
  const both = rateLimitDelayMs({
    headers: new Headers({ "retry-after-ms": "2500", "retry-after": "30" }),
    retryIndex: 1,
    maxWaitMs: 60_000,
    random: () => 0,
  });
  assert.equal(both, 2_500);
  const seconds = rateLimitDelayMs({
    headers: new Headers({ "retry-after": "30" }),
    retryIndex: 1,
    maxWaitMs: 4_000,
    random: () => 1,
  });
  assert.equal(seconds, 4_000);
  const reset = rateLimitDelayMs({
    headers: new Headers({
      "x-ratelimit-reset-requests": "2",
      "x-ratelimit-reset-tokens": "12",
    }),
    retryIndex: 1,
    maxWaitMs: 60_000,
    random: () => 0,
  });
  assert.equal(reset, 12_000);
  const dated = rateLimitDelayMs({
    headers: new Headers({ "retry-after": new Date(10_000).toUTCString() }),
    retryIndex: 1,
    maxWaitMs: 60_000,
    random: () => 0,
    now: 5_000,
  });
  assert.equal(dated, 5_000);
  const jitter = rateLimitDelayMs({
    headers: new Headers(),
    retryIndex: 3,
    maxWaitMs: 60_000,
    random: () => 0.5,
  });
  assert.equal(jitter, 2_000);
  const capped = rateLimitDelayMs({
    headers: new Headers(),
    retryIndex: 10,
    maxWaitMs: 1_000,
    random: () => 1,
  });
  assert.equal(capped, 1_000);
  assert.equal(rateLimitBudgetMs(0), DEFAULT_RATE_LIMIT_BUDGET_MS);
  assert.equal(rateLimitBudgetMs(45_000), DEFAULT_RATE_LIMIT_BUDGET_MS + 4 * 60_000);
});

test("a stop signal interrupts backoff and the stall watchdog stays quiet", async () => {
  const directory = await import("node:os").then((os) =>
    import("node:fs/promises").then((fs) => fs.mkdtemp(`${os.tmpdir()}/rate-limit-`)),
  );
  const ledger = new LiveLedger(
    { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
    `${directory}/ledger.json`,
  );
  const stop = new AbortController();
  let fetches = 0;
  const session = new LiveSession(ledger, [], false, {
    endpoint: "https://example.openai.azure.com/",
    apiKey: "sk-test-secret-key-value",
    deployment: "loopiter-gpt-5-6",
    apiVersion: "v1",
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: { message: "prompt text sk-test-secret-key-value" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after-ms": "60000" },
      });
    },
    maxTokensPerMinute: 0,
    maxRetryWaitMs: 60_000,
    max429Retries: 5,
    requestTimeoutMs: 5_000,
    maxTotalWaitMs: 120_000,
    now: Date.now,
    sleep: () => new Promise(() => undefined),
    random: () => 0,
    predictMaxOutputTokens: 128,
    proposeMaxOutputTokens: 128,
    reasoningEffort: "low",
  });
  session.bindStop(stop.signal);
  let stalled = 0;
  const watchdog = createStallWatchdog({
    intervalMs: 15,
    stallMs: 40,
    lastActivity: () => session.activityMs(),
    onStall: () => {
      stalled += 1;
    },
  });
  const pending = session.generate(
    { instructions: "answer", input: "{}", name: "freeform_answer", schema: { type: "object" } },
    "{}",
    128,
    async (_maximum, call) => (await call()).value,
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stalled, 0);
  assert.equal(fetches, 1);
  stop.abort();
  await assert.rejects(pending);
  assert.equal(fetches, 1);
  assert.equal(ledger.totalMicroUsd, 0);
  assert.equal(ledger.rejectedAttempts, 1);
  watchdog.stop();
  await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
});

test("a timeout still spends the ceiling after a 429 is released", async () => {
  const directory = await import("node:os").then((os) =>
    import("node:fs/promises").then((fs) => fs.mkdtemp(`${os.tmpdir()}/rate-charge-`)),
  );
  const ledger = new LiveLedger(
    { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 1, cachedInputUsdPerMillion: 0 },
    `${directory}/ledger.json`,
  );
  let fetches = 0;
  const session = new LiveSession(ledger, [], false, {
    endpoint: "https://example.openai.azure.com/",
    apiKey: "test-key",
    deployment: "loopiter-gpt-5-6",
    apiVersion: "v1",
    fetch: async (_url, init) => {
      fetches += 1;
      if (fetches === 1) {
        return new Response("{}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "0" },
        });
      }
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (!signal || signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
      throw new Error("hung");
    },
    maxTokensPerMinute: 0,
    maxRetryWaitMs: 1_000,
    max429Retries: 2,
    requestTimeoutMs: 30,
    maxTotalWaitMs: 5_000,
    now: Date.now,
    sleep: async () => undefined,
    random: () => 0,
    predictMaxOutputTokens: 32,
    proposeMaxOutputTokens: 32,
    reasoningEffort: null,
  });
  await assert.rejects(
    session.generate(
      { instructions: "answer", input: "{}", name: "freeform_answer", schema: { type: "object" } },
      "xxxx",
      32,
      async (_maximum, call) => (await call()).value,
      new AbortController().signal,
    ),
  );
  assert.equal(ledger.rejectedAttempts, 1);
  assert.ok(ledger.totalMicroUsd > 0);
  assert.equal(fetches, 3);
  await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
});

test("HotpotQA propose sends supporting paragraphs inside the byte budget", () => {
  const rows = Array.from({ length: 30 }, (_, index) => longRow(index));
  const payload = hotpotTask.proposePayload(hotpotTask.baselinePrompt, rows, []);
  const parsed = JSON.parse(payload) as {
    examples: { question: string; paragraphs: Paragraph[]; answer: string; score: number }[];
  };
  assert.ok(Buffer.byteLength(payload, "utf8") <= PROPOSE_BYTE_BUDGET);
  assert.ok(parsed.examples.length > 0);
  assert.ok(parsed.examples.length <= PROPOSE_EXAMPLE_CAP);
  for (const example of parsed.examples) {
    assert.ok(example.paragraphs.length < 10);
    assert.ok(example.paragraphs.every((paragraph) => paragraph.title.startsWith("Support")));
  }
  assert.equal(parsed.examples[0]?.score, 0);
  assert.equal(payload, hotpotTask.proposePayload(hotpotTask.baselinePrompt, rows, []));
  const plan = planTask(hotpotTask, {
    label: "smoke",
    seeds: [1],
    sizes: { optimization: 30, validation: 30, audit: 30, production: 30, heldOut: 30 },
    limits: resolveLimits({}, hotpotTask),
    deployment: "loopiter-gpt-5-6",
  });
  const propose = plan.arms["one-shot"].find((call) => call.kind === "propose");
  assert.ok(propose);
  assert.ok(propose!.inputTokens < 8_000);
  const ifbenchRows = Array.from({ length: 40 }, (_, index) => ifbenchRow(index));
  const feedback = ifbenchRows.map((_, index) =>
    index === 3 ? [{ id: "format:options", strict: false, loose: false }] : [],
  );
  const ifbenchPayload = ifbenchTask.proposePayload(ifbenchTask.baselinePrompt, ifbenchRows, feedback);
  const ifbenchParsed = JSON.parse(ifbenchPayload) as { examples: { prompt: string }[] };
  assert.ok(Buffer.byteLength(ifbenchPayload, "utf8") <= PROPOSE_BYTE_BUDGET);
  assert.equal(ifbenchParsed.examples[0]?.prompt, "prompt-3");
  assert.ok(ifbenchParsed.examples.length <= PROPOSE_EXAMPLE_CAP);
});

test("a rate-limited controller call retries without failing the arm", async () => {
  const directory = await import("node:os").then((os) =>
    import("node:fs/promises").then((fs) => fs.mkdtemp(`${os.tmpdir()}/controller-retry-`)),
  );
  const original = console.error;
  console.error = () => undefined;
  let fetches = 0;
  const rejections = 24;
  try {
    const ledger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
      `${directory}/ledger.json`,
    );
    const session = new LiveSession(ledger, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: "test-key",
      deployment: "loopiter-gpt-5-6",
      apiVersion: "v1",
      fetch: async (_url, init) => {
        fetches += 1;
        if (fetches <= rejections) {
          return new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after-ms": "0" },
          });
        }
        const request = JSON.parse(String(init?.body ?? "{}")) as { text?: { format?: { name?: string } } };
        const text = JSON.stringify(
          request.text?.format?.name === PROPOSE_NAME
            ? { fragment: `${hotpotTask.baselinePrompt}\nBe concise.` }
            : { text: "unknown" },
        );
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text }] }],
            usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 1_000,
      max429Retries: rejections + 2,
      requestTimeoutMs: 5_000,
      maxTotalWaitMs: 60_000,
      now: Date.now,
      sleep: async () => undefined,
      random: () => 0,
      predictMaxOutputTokens: hotpotTask.predict.defaultValue,
      proposeMaxOutputTokens: hotpotTask.propose.defaultValue,
      reasoningEffort: "low",
      maximumInputBytes: 262_144,
    });
    const loaded = hotpotTask.fixtures();
    const split = buildSeededSplit({
      pool: loaded.pool,
      heldOut: loaded.heldOut,
      seed: 1,
      sizes: hotpotTask.fixtureSizes,
    });
    const directMeter = async <T>(_maximum: number, call: () => Promise<{ value: T; tokens: number | null }>) =>
      (await call()).value;
    const result = await runController({
      task: hotpotTask,
      split,
      runner: {
        async answer(prompt, row, context) {
          const payload = hotpotTask.predictPayload(row);
          const generation = await session.generate(
            { instructions: prompt, input: payload, name: PREDICT_NAME, schema: hotpotTask.predictSchema() },
            requestBody({
              model: session.provider.model,
              instructions: prompt,
              payload,
              name: PREDICT_NAME,
              schema: hotpotTask.predictSchema(),
              maxOutputTokens: session.limits.predictMaxOutputTokens,
              reasoningEffort: session.limits.reasoningEffort,
            }),
            session.limits.predictMaxOutputTokens,
            context ? context.meter.bind(context) : directMeter,
            context?.signal ?? new AbortController().signal,
          );
          const text = generation.value.text;
          return { text: typeof text === "string" ? text : "", latencyMs: generation.latencyMs };
        },
        async propose(request, context) {
          const payload = hotpotTask.proposePayload(request.current, request.rows, request.feedback);
          const generation = await session.generate(
            {
              instructions: PROPOSE_INSTRUCTIONS,
              input: payload,
              name: PROPOSE_NAME,
              schema: hotpotTask.proposeSchema(),
            },
            requestBody({
              model: session.provider.model,
              instructions: PROPOSE_INSTRUCTIONS,
              payload,
              name: PROPOSE_NAME,
              schema: hotpotTask.proposeSchema(),
              maxOutputTokens: session.limits.proposeMaxOutputTokens,
              reasoningEffort: session.limits.reasoningEffort,
            }),
            session.limits.proposeMaxOutputTokens,
            context ? context.meter.bind(context) : directMeter,
            context?.signal ?? new AbortController().signal,
          );
          const fragment = generation.value.fragment;
          if (typeof fragment !== "string") throw new Error("Model proposal is missing the prompt.");
          return fragment;
        },
      },
      mode: "improve",
      observation: "honest",
      minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
      batchSize: 1,
      observeChunk: 2,
      latencyMs: 120_000,
      predictMaxOutputTokens: hotpotTask.predict.defaultValue,
      proposeMaxOutputTokens: hotpotTask.propose.defaultValue,
      modelId: "loopiter-gpt-5-6",
      scenario: "rate-limit-retry",
      tickLimit: 40,
    });
    assert.equal(result.state, "no_improvement");
    assert.equal(result.reason, "validation_failed");
    assert.ok(fetches > rejections);
  } finally {
    console.error = original;
    await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
  }
});

function longRow(index: number): HotpotExample {
  const paragraphs = Array.from({ length: 10 }, (_, paragraph) => ({
    title: paragraph < 2 ? `Support ${paragraph}` : `Distractor ${index}-${paragraph}`,
    text: `Sentence ${paragraph} `.repeat(40),
  }));
  return {
    id: `row-${index}`,
    baselinePass: index % 5 !== 0,
    question: `Question ${index} about a long page`,
    answer: "Paris",
    paragraphs,
    supportingTitles: ["Support 0", "Support 1"],
  };
}

function ifbenchRow(index: number): IfExample {
  return {
    id: `if-${index}`,
    baselinePass: false,
    prompt: `prompt-${index}`,
    instructionIdList: ["format:options"],
    kwargs: [{}],
  };
}
