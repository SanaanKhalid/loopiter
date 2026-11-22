import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderRequestError, parseProviderErrorBody } from "../../examples/prompt-improvement/provider.js";
import { ifbenchTask } from "../ifbench/task.js";
import type { IfExample } from "../ifbench/fixtures.js";
import { UnsupportedInstructionError } from "../ifbench/score.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { row } from "../hotpotqa/fixtures.js";
import { LiveLedger, LiveSession, NETWORK_ATTEMPTS } from "../kb-qa/live.js";
import { PREDICT_NAME, PROPOSE_NAME } from "./instructions.js";
import {
  ITEM_FAILURE_CONSECUTIVE,
  ITEM_FAILURE_FRACTION,
  perItemReason,
  renderItemFailureSummary,
} from "./item-failures.js";
import { resolveLimits } from "./limits.js";
import { runLiveTask, type PublicLiveOptions } from "./live.js";

const PROMPT = "format-options prompt that must stay out of logs";
const KEY = "sk-test-secret-key-value";
const QUERY = "query-secret-not-a-header";
const HEADER_KEY = "header-secret-value";
const LEAKS = [PROMPT, KEY, QUERY, HEADER_KEY];

test("provider error parsing keeps only allowlisted fields", () => {
  const detail = parseProviderErrorBody(400, {
    error: {
      message: `${PROMPT} ${KEY} https://example.openai.azure.com/openai/v1/responses?sig=${QUERY}`,
      type: "invalid_request_error",
      code: "content_filter",
      param: PROMPT,
      innererror: {
        code: "ResponsibleAIPolicyViolation",
        content_filter_result: {
          hate: { filtered: true, severity: "high" },
          violence: { filtered: false, severity: "safe" },
          "not a token!": { filtered: true, severity: "high" },
        },
      },
    },
  });
  assert.equal(detail.code, "content_filter");
  assert.equal(detail.type, "invalid_request_error");
  assert.equal(detail.innerCode, "ResponsibleAIPolicyViolation");
  assert.deepEqual(detail.categories, [{ category: "hate", severity: "high" }]);
  assert.equal(perItemReason(new ProviderRequestError(400, null, null, detail)), "content_filter");
  assert.equal(
    perItemReason(
      new ProviderRequestError(400, null, null, {
        status: 400,
        code: "cyber_policy",
        type: "invalid_request",
        innerCode: null,
        categories: [],
        incompleteReason: null,
      }),
    ),
    "cyber_policy",
  );
  assert.equal(
    perItemReason(
      new ProviderRequestError(400, null, null, {
        status: 400,
        code: "organization_policy_violation",
        type: "invalid_request_error",
        innerCode: null,
        categories: [],
        incompleteReason: null,
      }),
    ),
    null,
  );
  assert.equal(
    perItemReason(
      new ProviderRequestError(400, null, null, {
        ...detail,
        code: "invalid_parameter",
        innerCode: null,
        categories: [],
      }),
    ),
    null,
  );
  assert.equal(JSON.stringify(detail).includes(PROMPT), false);
  assert.equal(JSON.stringify(detail).includes(KEY), false);
});

test("a non-retryable 400 logs only the safe provider fields", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (line?: unknown) => {
    logs.push(String(line));
  };
  const directory = await mkdtemp(join(tmpdir(), "provider-log-"));
  try {
    const ledger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
      join(directory, "ledger.json"),
    );
    const session = new LiveSession(ledger, [KEY], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "loopiter-gpt-5-6",
      apiVersion: "v1",
      fetch: async () => contentFilterResponse(),
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 1_000,
      max429Retries: 1,
      requestTimeoutMs: 5_000,
      maxTotalWaitMs: 5_000,
      now: Date.now,
      sleep: async () => undefined,
      random: () => 0,
      predictMaxOutputTokens: 1024,
      proposeMaxOutputTokens: 1024,
      reasoningEffort: "low",
    });
    await assert.rejects(
      session.generate(
        {
          instructions: "answer",
          input: JSON.stringify({ task: PROMPT }),
          name: PREDICT_NAME,
          schema: { type: "object" },
        },
        "{}",
        1024,
        async (_maximum, call) => (await call()).value,
        new AbortController().signal,
      ),
      /HTTP 400, code=content_filter/,
    );
    const text = logs.join("\n");
    assert.match(text, /code=content_filter/);
    assert.match(text, /categories=hate:high/);
    assert.equal(text.includes("violence"), false);
    assertNoLeaks(text);
    assert.equal(ledger.attempts, 0);
    assert.equal(ledger.rejectedAttempts, 1);
    assert.equal(ledger.totalMicroUsd, 0);
  } finally {
    console.error = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("content filter and incomplete predictions score 0 and the run continues", async () => {
  const seen = await runScript(10, (predicts) => {
    if (predicts === 1) return contentFilterResponse();
    if (predicts === 2) return incompleteResponse();
    return answerResponse("Paris");
  });
  assert.equal(seen.report.stopped, null);
  assert.equal(seen.report.perSeed.length, 1);
  assert.equal(typeof seen.report.perSeed[0]?.controllerState, "string");
  assert.equal(typeof seen.report.perSeed[0]?.controllerReason, "string");
  assert.ok(seen.report.perSeed[0]?.controllerReason);
  assert.ok("controllerDetail" in (seen.report.perSeed[0] ?? {}));
  assert.equal(seen.report.perSeed[0]?.baseline.trials, 10);
  assert.equal(seen.report.perSeed[0]?.baseline.successes, 8);
  assert.equal(seen.report.itemFailures.length, 2);
  assert.equal(seen.report.itemFailures[0]?.reason, "content_filter");
  assert.deepEqual(seen.report.itemFailures[0]?.categories, ["hate:high"]);
  assert.equal(seen.report.itemFailures[1]?.reason, "incomplete:max_output_tokens");
  assert.equal(seen.report.itemFailures[0]?.arm, "baseline");
  assert.equal(seen.report.itemFailures[0]?.split, "held-out");
  assert.ok(seen.report.itemFailureCounts.some((row) => row.arm === "baseline" && row.split === "held-out" && row.count === 2));
  assert.match(renderItemFailureSummary(seen.report.itemFailures), /baseline held-out content_filter: 1/);
  assert.match(renderItemFailureSummary(seen.report.itemFailures), /baseline held-out incomplete:max_output_tokens: 1/);
  assert.equal(seen.report.spend.rejectedAttempts, 1);
  assert.ok(seen.report.spend.attempts > 0);
  assert.ok(seen.fetches > 10);
  assertNoLeaks(seen.logs);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("a refusal and an empty output score 0 and the run continues", async () => {
  const seen = await runScript(10, (predicts) => {
    if (predicts === 1) return refusalResponse();
    if (predicts === 2) return emptyOutputResponse();
    return answerResponse("Paris");
  });
  assert.equal(seen.report.stopped, null);
  assert.equal(seen.report.perSeed.length, 1);
  assert.equal(seen.report.perSeed[0]?.baseline.trials, 10);
  assert.equal(seen.report.perSeed[0]?.baseline.successes, 8);
  assert.deepEqual(
    seen.report.itemFailures.map((failure) => failure.reason),
    ["refusal", "empty_output"],
  );
  assert.equal(seen.report.itemFailures[0]?.arm, "baseline");
  assert.equal(seen.report.itemFailures[0]?.split, "held-out");
  assertNoLeaks(seen.logs);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("repeated refusals trip the consecutive valve", async () => {
  const seen = await runScript(25, (predicts) =>
    predicts <= ITEM_FAILURE_CONSECUTIVE ? refusalResponse() : answerResponse("Paris"),
  );
  assert.equal(seen.report.stopped?.reason, "item_failure_consecutive");
  assert.equal(seen.report.itemFailures.length, ITEM_FAILURE_CONSECUTIVE);
  assert.ok(seen.report.itemFailures.every((failure) => failure.reason === "refusal"));
  assert.equal(seen.fetches, ITEM_FAILURE_CONSECUTIVE);
});

test("invalid JSON scores 0 and repeated invalid output trips the valve", async () => {
  const once = await runScript(10, (predicts) =>
    predicts === 1 ? invalidJsonResponse() : answerResponse("Paris"),
  );
  assert.equal(once.report.stopped, null);
  assert.equal(once.report.perSeed[0]?.baseline.successes, 9);
  assert.deepEqual(
    once.report.itemFailures.map((failure) => failure.reason),
    ["invalid_output"],
  );
  assertNoLeaks(JSON.stringify(once.report));
  const repeated = await runScript(25, (predicts) =>
    predicts <= ITEM_FAILURE_CONSECUTIVE ? invalidJsonResponse() : answerResponse("Paris"),
  );
  assert.equal(repeated.report.stopped?.reason, "item_failure_consecutive");
  assert.equal(repeated.report.itemFailures.length, ITEM_FAILURE_CONSECUTIVE);
  assert.ok(repeated.report.itemFailures.every((failure) => failure.reason === "invalid_output"));
});

test("prompt-scoped 400s score 0 and 403 and 404 stop the run", async () => {
  const scoped = await runScript(20, (predicts) => {
    const code = ["context_length_exceeded", "string_above_max_length", "invalid_prompt"][predicts - 1];
    if (!code) return answerResponse("Paris");
    return jsonResponse(400, {
      error: { message: PROMPT, type: "invalid_request_error", code },
    });
  });
  assert.equal(scoped.report.stopped, null);
  assert.deepEqual(
    scoped.report.itemFailures.map((failure) => failure.reason),
    ["context_length_exceeded", "string_above_max_length", "invalid_prompt"],
  );
  assert.equal(scoped.report.perSeed[0]?.baseline.successes, 17);
  assertNoLeaks(JSON.stringify(scoped.report));

  for (const status of [403, 404]) {
    const stopped = await runScript(4, () =>
      jsonResponse(status, { error: { message: `${PROMPT} ${KEY}`, code: "access_denied" } }),
    );
    assert.equal(stopped.report.stopped?.reason, "provider_error");
    assert.match(stopped.report.stopped?.message ?? "", new RegExp(`HTTP ${status}`));
    assert.equal(stopped.report.itemFailures.length, 0);
    assert.equal(stopped.fetches, 1);
    assertNoLeaks(JSON.stringify(stopped.report));
  }
});

test("policy refusals stay on the item report and later seeds still run", async () => {
  for (const code of ["cyber_policy", "content_filter"] as const) {
    const item = await runIfbench(2, (call) =>
      call.kind === "predict" && call.predicts === 1 ? policyResponse(code) : answerResponse("quartz done"),
    );
    assert.equal(item.report.stopped, null);
    assert.equal(item.report.perSeed.length, 2);
    assert.equal(item.report.perSeed.at(-1)?.seed, 2);
    assert.equal(item.report.itemFailures.some((failure) => failure.reason === code), true);
    assert.equal(item.report.perSeed.some((row) => row.controllerReason === "callback_failed"), false);
    assertNoLeaks(JSON.stringify(item.report));

    const controller = await runIfbench(2, (call) =>
      call.kind === "propose" && call.proposes === 2 ? policyResponse(code) : answerResponse("quartz done"),
    );
    assert.equal(controller.report.stopped, null);
    assert.equal(controller.report.perSeed.length, 2);
    assert.equal(controller.report.perSeed.at(-1)?.seed, 2);
    assert.equal(
      controller.report.itemFailures.some(
        (failure) => failure.reason === code && failure.arm === "controller" && failure.split === "propose",
      ),
      true,
    );
    assert.equal(controller.report.perSeed.some((row) => row.controllerReason === "callback_failed"), false);
    assertNoLeaks(JSON.stringify(controller.report));

    const probe = await runIfbench(2, () => answerResponse("quartz done"));
    assert.equal(probe.report.perSeed.length, 2);
    assert.equal(probe.fetches % 2, 0);
    const lastOfSeed = probe.fetches / 2;
    const last = await runIfbench(2, (call) =>
      call.index === lastOfSeed ? policyResponse(code) : answerResponse("quartz done"),
    );
    assert.equal(last.report.stopped, null);
    assert.equal(last.report.perSeed.length, 2);
    assert.equal(last.report.perSeed.at(-1)?.seed, 2);
    assert.equal(last.report.itemFailures.some((failure) => failure.reason === code), true);
    assertNoLeaks(JSON.stringify(last.report));
  }

  const unauthorized = await runIfbench(2, () =>
    jsonResponse(401, { error: { message: `${PROMPT} ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } }),
  );
  assert.equal(unauthorized.report.stopped?.reason, "provider_error");
  assert.match(unauthorized.report.stopped?.message ?? "", /HTTP 401/);
  assert.equal(unauthorized.report.itemFailures.length, 0);
  assert.equal(unauthorized.report.perSeed.length, 0);
  assert.equal(unauthorized.fetches, 1);
  assertNoLeaks(JSON.stringify(unauthorized.report));
});

test("a throw inside one seed is reported and the other seeds finish", async () => {
  const seen = await runIfbench(2, (call) => {
    if (call.index === 1) throw new Error("provider threw inside the seed");
    return answerResponse("quartz done");
  });
  assert.equal(seen.report.stopped, null);
  assert.equal(seen.report.perSeed.length, 2);
  assert.equal(seen.report.perSeed[0]?.seed, 1);
  assert.equal(seen.report.perSeed[0]?.status, "failed");
  assert.equal(seen.report.perSeed[0]?.failure?.arm, "baseline");
  assert.equal(seen.report.perSeed[0]?.failure?.code, "seed_failed");
  assert.match(seen.report.perSeed[0]?.failure?.message ?? "", /provider threw inside the seed/);
  assert.equal(seen.report.seedFailures[0]?.seed, 1);
  assert.equal(seen.report.seedFailures[0]?.arm, "baseline");
  assert.equal(seen.report.seedFailures[0]?.code, "seed_failed");
  assert.equal(seen.report.perSeed[1]?.status, "complete");
  assert.ok((seen.report.perSeed[1]?.baseline.trials ?? 0) > 0);
  assert.equal(seen.report.passed, false);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("exhausted network retries fail the seed and the run continues", async () => {
  const seen = await runNetwork({ seeds: 2, failCalls: 1 });
  assert.equal(seen.report.stopped, null);
  assert.equal(seen.report.perSeed.length, 2);
  assert.equal(seen.report.perSeed[0]?.status, "failed");
  assert.equal(seen.report.perSeed[0]?.failure?.code, "network");
  assert.match(seen.report.perSeed[0]?.failure?.message ?? "", /socket down/);
  assert.equal(seen.report.perSeed[1]?.status, "complete");
  assert.equal(seen.report.passed, false);
  assert.ok(seen.fetches > NETWORK_ATTEMPTS);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("exhausted server errors fail the seed and the run continues", async () => {
  const seen = await runNetwork({ seeds: 2, failCalls: 1, status: 500 });
  assert.equal(seen.report.stopped, null);
  assert.equal(seen.report.perSeed.length, 2);
  assert.equal(seen.report.perSeed[0]?.status, "failed");
  assert.equal(seen.report.perSeed[0]?.failure?.code, "network");
  assert.match(seen.report.perSeed[0]?.failure?.message ?? "", /HTTP 500/);
  assert.equal(seen.report.perSeed[1]?.status, "complete");
  assert.equal(seen.fetches > NETWORK_ATTEMPTS, true);
  assert.equal(seen.report.passed, false);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("consecutive exhausted server errors trip the breaker", async () => {
  const seen = await runNetwork({ seeds: 2, failCalls: 99, networkFailures: 2, status: 503 });
  assert.equal(seen.report.stopped?.reason, "network_outage");
  assert.match(seen.report.stopped?.message ?? "", /2 calls in a row/);
  assert.equal(seen.report.perSeed.length, 1);
  assert.equal(seen.report.perSeed[0]?.status, "failed");
  assert.equal(seen.fetches, NETWORK_ATTEMPTS * 2);
  assert.equal(seen.report.passed, false);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("the network breaker stops the run after consecutive failures", async () => {
  const seen = await runNetwork({ seeds: 2, failCalls: 99, networkFailures: 2 });
  assert.equal(seen.report.stopped?.reason, "network_outage");
  assert.match(seen.report.stopped?.message ?? "", /2 calls in a row/);
  assert.equal(seen.report.perSeed.length, 1);
  assert.equal(seen.report.perSeed[0]?.status, "failed");
  assert.equal(seen.fetches, NETWORK_ATTEMPTS * 2);
  assert.equal(seen.report.passed, false);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("a seed whose propose calls are all refused is never_proposed", async () => {
  const seen = await runIfbench(2, (call) =>
    call.kind === "propose" ? policyResponse("cyber_policy") : answerResponse("quartz done"),
  );
  assert.equal(seen.report.stopped, null);
  assert.equal(seen.report.perSeed.length, 2);
  assert.ok(seen.report.proposeRefusals.calls > 0);
  assert.equal(seen.report.proposeRefusals.refused, seen.report.proposeRefusals.calls);
  for (const row of seen.report.perSeed) {
    assert.equal(row.status, "never_proposed");
    assert.equal(row.controllerReason, "never_proposed");
    assert.ok(row.proposeCalls > 0);
    assert.equal(row.proposeRefusals, row.proposeCalls);
  }
  assert.equal(
    seen.report.proposeRefusals.refused,
    seen.report.perSeed.reduce((sum, row) => sum + row.proposeRefusals, 0),
  );
  assertNoLeaks(JSON.stringify(seen.report));
});

test("an unlisted invalid_request policy code stops the run", async () => {
  const seen = await runScript(4, () =>
    jsonResponse(400, {
      error: {
        message: `${PROMPT} ${KEY}`,
        type: "invalid_request_error",
        code: "organization_policy_violation",
      },
    }),
  );
  assert.equal(seen.report.stopped?.reason, "provider_error");
  assert.match(seen.report.stopped?.message ?? "", /organization_policy_violation/);
  assert.equal(seen.report.itemFailures.length, 0);
  assert.equal(seen.report.perSeed.length, 0);
  assert.equal(seen.fetches, 1);
  assertNoLeaks(JSON.stringify(seen.report));
});

test("auth, a systemic 400, and a persistent 429 stop the run", async () => {
  const unauthorized = await runScript(4, () =>
    jsonResponse(401, { error: { message: `${PROMPT} ${KEY}`, code: "invalid_api_key" } }),
  );
  assert.equal(unauthorized.report.stopped?.reason, "provider_error");
  assert.match(unauthorized.report.stopped?.message ?? "", /HTTP 401/);
  assert.equal(unauthorized.report.itemFailures.length, 0);
  assert.equal(unauthorized.report.perSeed.length, 0);
  assert.equal(unauthorized.fetches, 1);
  assertNoLeaks(unauthorized.logs);
  assertNoLeaks(JSON.stringify(unauthorized.report));

  const systemic = await runScript(4, () =>
    jsonResponse(400, {
      error: { message: PROMPT, type: "invalid_request_error", code: "invalid_parameter" },
    }),
  );
  assert.equal(systemic.report.stopped?.reason, "provider_error");
  assert.match(systemic.report.stopped?.message ?? "", /code=invalid_parameter/);
  assert.equal(systemic.report.itemFailures.length, 0);
  assert.equal(systemic.fetches, 1);
  assertNoLeaks(JSON.stringify(systemic.report));

  const limited = await runScript(
    4,
    () =>
      jsonResponse(
        429,
        { error: { message: `${PROMPT} ${KEY}` } },
        { "retry-after": "0" },
      ),
    { max429Retries: 1 },
  );
  assert.equal(limited.report.stopped?.reason, "rate_limit");
  assert.match(limited.report.stopped?.message ?? "", /HTTP 429/);
  assert.equal(limited.report.itemFailures.length, 0);
  assert.equal(limited.fetches, 2);
  assertNoLeaks(JSON.stringify(limited.report));
});

test("an unsupported instruction stops the live run", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (line?: unknown) => {
    logs.push(String(line));
  };
  const directory = await mkdtemp(join(tmpdir(), "unsupported-instruction-"));
  try {
    const task = {
      ...ifbenchTask,
      fullSizes: { optimization: 2, validation: 2, audit: 2, production: 2, heldOut: 2 },
      scoreMany: async () => {
        throw new UnsupportedInstructionError("not:real");
      },
    };
    const example = (id: string) => ({
      id,
      baselinePass: false,
      prompt: `Prompt ${PROMPT}`,
      instructionIdList: ["not:real"],
      kwargs: [{}],
    });
    const report = await runLiveTask(
      task,
      {
        seeds: [1],
        smoke: true,
        deployment: "loopiter-gpt-5-6",
        apiVersion: "v1",
        endpoint: "https://example.openai.azure.com/",
        apiKey: KEY,
        prices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
        totalCapUsd: 50,
        warnUsd: 40,
        invocationCapUsd: 50,
        stopAtWarn: false,
        ledgerPath: join(directory, "ledger.json"),
        limits: resolveLimits({}, ifbenchTask),
        minimumImprovement: 0,
        maxTokensPerMinute: 0,
        maxRetryWaitMs: 1_000,
        max429Retries: 1,
        requestTimeoutMs: 5_000,
        maxTotalWaitMs: 5_000,
        stallTimeoutMs: 600_000,
        fetch: async () => answerResponse("hello"),
      },
      {
        pool: Array.from({ length: 8 }, (_, index) => example(`pool-${index}`)),
        heldOut: [example("held-0"), example("held-1")],
      },
    );
    assert.equal(report.stopped?.reason, "unsupported_instruction");
    assert.match(report.stopped?.message ?? "", /not:real/);
    assert.equal((report.stopped?.message ?? "").includes(PROMPT), false);
    assert.equal(report.perSeed.length, 0);
  } finally {
    console.error = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("consecutive failures and the split fraction stop the run", async () => {
  assert.equal(ITEM_FAILURE_CONSECUTIVE, 5);
  assert.equal(ITEM_FAILURE_FRACTION, 0.2);
  const consecutive = await runScript(25, (predicts) =>
    predicts <= 5 ? contentFilterResponse() : answerResponse("Paris"),
  );
  assert.equal(consecutive.report.stopped?.reason, "item_failure_consecutive");
  assert.match(consecutive.report.stopped?.message ?? "", /5 failed predictions in a row/);
  assert.equal(consecutive.report.itemFailures.length, 5);
  assert.equal(consecutive.fetches, 5);
  assert.equal(consecutive.report.spend.attempts, 0);
  assert.equal(consecutive.report.spend.rejectedAttempts, 5);

  let failures = 0;
  const fraction = await runScript(10, (predicts) => {
    if (predicts % 2 === 1 && failures < 3) {
      failures += 1;
      return contentFilterResponse();
    }
    return answerResponse("Paris");
  });
  assert.equal(fraction.report.stopped?.reason, "item_failure_fraction");
  assert.match(fraction.report.stopped?.message ?? "", /3 of 10/);
  assert.match(fraction.report.stopped?.message ?? "", /above 20%/);
  assert.equal(fraction.report.itemFailures.length, 3);
  assert.equal(fraction.fetches, 5);
});

test("output truncations score 0 and stop on their own rate", async () => {
  const truncated = await runScript(10, (predicts) =>
    predicts <= 3 ? incompleteResponse() : answerResponse("Paris"),
  );
  assert.equal(truncated.report.stopped?.reason, "output_truncated");
  assert.match(truncated.report.stopped?.message ?? "", /max_output_tokens/);
  assert.match(truncated.report.stopped?.message ?? "", /3 of 10/);
  assert.equal(truncated.report.itemFailures.length, 3);
  assert.ok(truncated.report.itemFailures.every((failure) => failure.reason === "incomplete:max_output_tokens"));

  const mixed = await runScript(10, (predicts) => {
    if (predicts === 1 || predicts === 3) return incompleteResponse();
    if (predicts === 2) return contentFilterResponse();
    return answerResponse("Paris");
  });
  assert.equal(mixed.report.stopped, null);
  assert.equal(mixed.report.perSeed.length, 1);
  assert.equal(
    mixed.report.itemFailures.filter((failure) => failure.reason === "incomplete:max_output_tokens").length,
    2,
  );

  const cluster = await runScript(30, (predicts) =>
    predicts <= 5 ? incompleteResponse() : answerResponse("Paris"),
  );
  assert.equal(cluster.report.stopped, null);
  assert.equal(cluster.report.perSeed.length, 1);
  assert.equal(
    cluster.report.itemFailures.filter((failure) => failure.reason === "incomplete:max_output_tokens").length,
    5,
  );
});

async function runScript(
  heldOut: number,
  onPredict: (predicts: number) => Response,
  extra?: Partial<PublicLiveOptions>,
): Promise<{ report: Awaited<ReturnType<typeof runLiveTask>>; fetches: number; logs: string }> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (line?: unknown) => {
    logs.push(String(line));
  };
  const directory = await mkdtemp(join(tmpdir(), "item-failure-"));
  let fetches = 0;
  let predicts = 0;
  try {
    const task = {
      ...hotpotTask,
      fullSizes: { optimization: 2, validation: 5, audit: 10, production: 2, heldOut },
    };
    const report = await runLiveTask(
      task,
      {
        seeds: [1],
        smoke: true,
        deployment: "loopiter-gpt-5-6",
        apiVersion: "v1",
        endpoint: "https://example.openai.azure.com/",
        apiKey: KEY,
        prices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
        totalCapUsd: 50,
        warnUsd: 40,
        invocationCapUsd: 50,
        stopAtWarn: false,
        ledgerPath: join(directory, "ledger.json"),
        limits: resolveLimits({}, hotpotTask),
        minimumImprovement: 0,
        maxTokensPerMinute: 0,
        maxRetryWaitMs: 1_000,
        max429Retries: extra?.max429Retries ?? 0,
        requestTimeoutMs: 5_000,
        maxTotalWaitMs: 5_000,
        stallTimeoutMs: 600_000,
        fetch: async (_url, init) => {
          fetches += 1;
          const raw = typeof init?.body === "string" ? init.body : "";
          const parsed = raw
            ? (JSON.parse(raw) as { text?: { format?: { name?: string } } })
            : {};
          if (parsed.text?.format?.name === PROPOSE_NAME) return answerResponse(hotpotTask.baselinePrompt, "fragment");
          predicts += 1;
          return onPredict(predicts);
        },
        ...extra,
      },
      {
        pool: Array.from({ length: 19 }, (_, index) => row(`pool-${index}`, "Paris", false)),
        heldOut: Array.from({ length: heldOut }, (_, index) => row(`held-${index}`, "Paris", false)),
      },
    );
    return { report, fetches, logs: logs.join("\n") };
  } finally {
    console.error = original;
    await rm(directory, { recursive: true, force: true });
  }
}

function assertNoLeaks(text: string): void {
  for (const leak of LEAKS) assert.equal(text.includes(leak), false, leak);
}

interface ScriptCall {
  index: number;
  predicts: number;
  proposes: number;
  kind: "predict" | "propose";
}

async function runIfbench(
  seeds: number,
  onCall: (call: ScriptCall) => Response,
): Promise<{ report: Awaited<ReturnType<typeof runLiveTask>>; fetches: number }> {
  const directory = await mkdtemp(join(tmpdir(), "ifbench-policy-"));
  let fetches = 0;
  let predicts = 0;
  let proposes = 0;
  const sizes = { optimization: 6, validation: 6, audit: 10, production: 6, heldOut: 6 };
  const pool = Array.from({ length: 28 }, (_, index) => ifRow(`pool-${index}`));
  const heldOut = Array.from({ length: sizes.heldOut }, (_, index) => ifRow(`held-${index}`));
  try {
    const report = await runLiveTask(
      {
        ...ifbenchTask,
        fullSizes: sizes,
        scoreMany: async (items) => items.map(() => ifbenchTask.emptyScore()),
      },
      {
        seeds: Array.from({ length: seeds }, (_, index) => index + 1),
        smoke: true,
        deployment: "loopiter-gpt-5-6",
        apiVersion: "v1",
        endpoint: "https://example.openai.azure.com/",
        apiKey: KEY,
        prices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
        totalCapUsd: 50,
        warnUsd: 40,
        invocationCapUsd: 50,
        stopAtWarn: false,
        ledgerPath: join(directory, "ledger.json"),
        limits: resolveLimits({}, ifbenchTask),
        minimumImprovement: 0,
        maxTokensPerMinute: 0,
        maxRetryWaitMs: 1_000,
        max429Retries: 0,
        requestTimeoutMs: 5_000,
        maxTotalWaitMs: 5_000,
        stallTimeoutMs: 600_000,
        fetch: async (_url, init) => {
          fetches += 1;
          const raw = typeof init?.body === "string" ? init.body : "";
          const parsed = raw
            ? (JSON.parse(raw) as { text?: { format?: { name?: string } } })
            : {};
          const kind = parsed.text?.format?.name === PROPOSE_NAME ? "propose" : "predict";
          if (kind === "propose") proposes += 1;
          else predicts += 1;
          const scripted = onCall({ index: fetches, predicts, proposes, kind });
          if (kind === "propose" && scripted.status === 200)
            return answerResponse(ifbenchTask.baselinePrompt, "fragment");
          return scripted;
        },
      },
      { pool, heldOut },
    );
    return { report, fetches };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runNetwork(input: {
  seeds: number;
  failCalls: number;
  networkFailures?: number;
  status?: number;
}): Promise<{ report: Awaited<ReturnType<typeof runLiveTask>>; fetches: number }> {
  const directory = await mkdtemp(join(tmpdir(), "network-seed-"));
  let fetches = 0;
  let failedCalls = 0;
  const sizes = { optimization: 2, validation: 5, audit: 10, production: 2, heldOut: 4 };
  try {
    const report = await runLiveTask(
      { ...hotpotTask, fullSizes: sizes },
      {
        seeds: Array.from({ length: input.seeds }, (_, index) => index + 1),
        smoke: true,
        deployment: "loopiter-gpt-5-6",
        apiVersion: "v1",
        endpoint: "https://example.openai.azure.com/",
        apiKey: KEY,
        prices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
        totalCapUsd: 50,
        warnUsd: 40,
        invocationCapUsd: 50,
        stopAtWarn: false,
        ledgerPath: join(directory, "ledger.json"),
        limits: resolveLimits({}, hotpotTask),
        minimumImprovement: 0,
        maxTokensPerMinute: 0,
        maxRetryWaitMs: 1,
        max429Retries: 1,
        requestTimeoutMs: 1_000,
        maxTotalWaitMs: 60_000,
        stallTimeoutMs: 600_000,
        ...(input.networkFailures === undefined
          ? {}
          : { maxConsecutiveNetworkFailures: input.networkFailures }),
        fetch: async (_url, init) => {
          fetches += 1;
          const attempt = (fetches - 1) % NETWORK_ATTEMPTS;
          if (failedCalls < input.failCalls) {
            if (attempt === NETWORK_ATTEMPTS - 1) failedCalls += 1;
            if (input.status !== undefined)
              return jsonResponse(input.status, {
                error: { message: "unavailable", type: "server_error", code: "internal_error" },
              });
            const error = new Error("socket down") as Error & { code: string };
            error.code = "ECONNRESET";
            throw error;
          }
          const raw = typeof init?.body === "string" ? init.body : "";
          const parsed = raw
            ? (JSON.parse(raw) as { text?: { format?: { name?: string } } })
            : {};
          if (parsed.text?.format?.name === PROPOSE_NAME)
            return answerResponse(hotpotTask.baselinePrompt, "fragment");
          return answerResponse("Paris");
        },
      },
      {
        pool: Array.from({ length: 19 }, (_, index) => row(`pool-${index}`, "Paris", false)),
        heldOut: Array.from({ length: sizes.heldOut }, (_, index) => row(`held-${index}`, "Paris", false)),
      },
    );
    return { report, fetches };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ifRow(id: string): IfExample {
  return {
    id,
    baselinePass: false,
    prompt: `Fixture ${id}`,
    instructionIdList: ["keywords:existence"],
    kwargs: [{ keywords: ["quartz"] }],
  };
}

function policyResponse(code: "cyber_policy" | "content_filter"): Response {
  return jsonResponse(400, {
    error: {
      message: `The prompt was ${PROMPT}. key ${KEY}.`,
      type: code === "cyber_policy" ? "invalid_request" : "invalid_request_error",
      code,
      ...(code === "content_filter"
        ? {
            innererror: {
              code: "ResponsibleAIPolicyViolation",
              content_filter_result: { hate: { filtered: true, severity: "high" } },
            },
          }
        : {}),
    },
  });
}

function contentFilterResponse(): Response {
  return jsonResponse(400, {
    error: {
      message: `The prompt was ${PROMPT}. key ${KEY}. url https://example.openai.azure.com/openai/responses?sig=${QUERY}`,
      type: "invalid_request_error",
      code: "content_filter",
      innererror: {
        code: "ResponsibleAIPolicyViolation",
        content_filter_result: {
          hate: { filtered: true, severity: "high" },
          violence: { filtered: false, severity: "safe" },
        },
      },
    },
  });
}

function incompleteResponse(): Response {
  return jsonResponse(200, {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: `${PROMPT} ${KEY}` }] }],
    usage: { input_tokens: 8, output_tokens: 256 },
  });
}

function invalidJsonResponse(): Response {
  return jsonResponse(200, {
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: `not-json ${PROMPT}` }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 2 },
  });
}

function refusalResponse(): Response {
  return jsonResponse(200, {
    status: "completed",
    output: [{ type: "message", content: [{ type: "refusal", refusal: PROMPT }] }],
    usage: { input_tokens: 8, output_tokens: 4 },
  });
}

function emptyOutputResponse(): Response {
  return jsonResponse(200, {
    status: "completed",
    output: [],
    usage: { input_tokens: 8, output_tokens: 1 },
  });
}

function answerResponse(text: string, field: "text" | "fragment" = "text"): Response {
  return jsonResponse(200, {
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ [field]: text }) }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8 },
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "api-key": HEADER_KEY, ...headers },
  });
}
