import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderRequestError, parseProviderErrorBody } from "../../examples/prompt-improvement/provider.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { row } from "../hotpotqa/fixtures.js";
import { LiveLedger, LiveSession } from "../kb-qa/live.js";
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

test("auth, systemic 400, repeated 5xx, and 429 stop the run", async () => {
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

  const server = await runScript(4, () =>
    jsonResponse(500, { error: { message: `${PROMPT} ${KEY}`, code: "internal_error" } }),
  );
  assert.equal(server.report.stopped?.reason, "provider_error");
  assert.match(server.report.stopped?.message ?? "", /HTTP 500/);
  assert.equal(server.report.itemFailures.length, 0);
  assert.equal(server.fetches, 2);
  assertNoLeaks(JSON.stringify(server.report));

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
      fullSizes: { optimization: 2, validation: 2, audit: 2, production: 2, heldOut },
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
        pool: Array.from({ length: 8 }, (_, index) => row(`pool-${index}`, "Paris", false)),
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
