import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatUsd, usdToMicro } from "../benchmarks/kb-qa/money.js";
import { SPLIT_COUNTS } from "../benchmarks/kb-qa/task.js";
import {
  baselineFragment,
  improveFragment,
  FACTS,
} from "../benchmarks/kb-qa/task.js";
import {
  FULL_SEEDS,
  LIVE_ENV,
  LiveLedger,
  LiveSession,
  MAX_ATTEMPTS,
  MAX_STEP_MS,
  PREDICT_MAX_OUTPUT_TOKENS,
  PROPOSE_MAX_OUTPUT_TOKENS,
  SMOKE_ROWS,
  TokenMinuteWindow,
  createExitGuard,
  liveCallbackTimeoutMs,
  liveDeadlinePlan,
  maxModelCallsPerStep,
  createInterruptHandler,
  createStallWatchdog,
  estimateFromEnv,
  formatProgress,
  liveCostMicroUsd,
  liveOptionsFromEnv,
  PACE_HEADROOM,
  pacedTokenLimit,
  planLiveRun,
  projectedWallMs,
  redactSecrets,
  renderEstimate,
  reservedAttemptsPerCall,
  runLiveBenchmark,
  startProgressTicker,
  type LivePrices,
} from "../benchmarks/kb-qa/live.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../benchmarks/kb-qa/run.js", import.meta.url));
const KEY = "unit-test-key-do-not-leak";

function scrubbed(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("AZURE_") ||
      key.startsWith("LOOPITER_BENCH") ||
      key === "LOOPITER_BENCHMARK_LIVE"
    )
      delete env[key];
  }
  return { ...env, ...extra };
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test("live plan keeps the offline call shape, about 12x on the full split", () => {
  const full = planLiveRun({ label: "full", seeds: [...FULL_SEEDS] });
  const perSeed =
    1 +
    SPLIT_COUNTS.validation * 2 +
    SPLIT_COUNTS.audit * 2 +
    SPLIT_COUNTS.production +
    SPLIT_COUNTS.test;
  assert.equal(full.baselineCalls, SPLIT_COUNTS.test * FULL_SEEDS.length);
  assert.equal(full.candidateCalls, perSeed * FULL_SEEDS.length);
  const ratio = full.candidateCalls / full.baselineCalls;
  assert.ok(ratio > 11 && ratio < 13, String(ratio));
  const smoke = planLiveRun({ label: "smoke", seeds: [1], rowLimit: SMOKE_ROWS });
  assert.equal(smoke.baselineCalls, SMOKE_ROWS);
  assert.equal(
    smoke.candidateCalls,
    1 + SMOKE_ROWS * 2 + SMOKE_ROWS * 2 + SMOKE_ROWS + SMOKE_ROWS,
  );
  assert.ok(smoke.inputTokens > 0);
  assert.equal(
    smoke.outputTokens,
    smoke.baselineCalls * PREDICT_MAX_OUTPUT_TOKENS +
      PROPOSE_MAX_OUTPUT_TOKENS +
      (smoke.candidateCalls - 1) * PREDICT_MAX_OUTPUT_TOKENS,
  );
});

test("cached usage is priced separately and the key is redacted", () => {
  assert.equal(
    liveCostMicroUsd(
      { input: 20, output: 5, cached: 4 },
      {
        inputUsdPerMillion: 0.75,
        outputUsdPerMillion: 4.5,
        cachedInputUsdPerMillion: 0.075,
      },
    ),
    Math.round(16 * 0.75 + 4 * 0.075 + 5 * 4.5),
  );
  const dumped = `headers api-key: ${KEY} authorization: Bearer ${KEY}`;
  const redacted = redactSecrets(dumped, [KEY]);
  assert.equal(redacted.includes(KEY), false);
  assert.match(redacted, /api-key:\[redacted\]/);
  assert.match(redacted, /authorization:\[redacted\]/);
});

test("gating refuses a live run without the allow flag, prices, or caps", () => {
  assert.throws(
    () => liveOptionsFromEnv(scrubbed(), blankArgs()),
    /LOOPITER_BENCH_ALLOW_LIVE/,
  );
  assert.throws(
    () =>
      liveOptionsFromEnv(
        scrubbed({
          [LIVE_ENV.allow]: "1",
          [LIVE_ENV.endpoint]: "https://example.openai.azure.com/",
          [LIVE_ENV.apiKey]: KEY,
        }),
        blankArgs(),
      ),
    /LOOPITER_BENCH_PRICE_INPUT_PER_1M/,
  );
  assert.throws(
    () =>
      liveOptionsFromEnv(
        scrubbed({
          [LIVE_ENV.allow]: "1",
          [LIVE_ENV.endpoint]: "https://example.openai.azure.com/",
          [LIVE_ENV.apiKey]: KEY,
          [LIVE_ENV.priceInput]: "0.75",
          [LIVE_ENV.priceOutput]: "4.5",
        }),
        blankArgs(),
      ),
    /LOOPITER_BENCH_PRICE_CACHED_INPUT_PER_1M/,
  );
  assert.throws(
    () =>
      liveOptionsFromEnv(scrubbed(pricedEnv()), blankArgs()),
    /LOOPITER_BENCH_TOTAL_CAP_USD/,
  );
  const options = liveOptionsFromEnv(scrubbed(readyEnv()), blankArgs());
  assert.equal(options.deployment, "gpt-5.4-mini");
  assert.equal(options.apiVersion, "v1");
  assert.equal(options.apiKey, KEY);
});

test("live gating rejects zero, negative, and non-numeric prices and invalid caps", async () => {
  const base = readyEnv();
  const refused = ["0", "0.0", "-1", "NaN", "Infinity", "abc", ""];
  for (const name of [LIVE_ENV.priceInput, LIVE_ENV.priceOutput])
    for (const value of refused)
      assert.throws(
        () => liveOptionsFromEnv(scrubbed({ ...base, [name]: value }), blankArgs()),
        new RegExp(name),
      );
  for (const name of [LIVE_ENV.totalCap, LIVE_ENV.warn, LIVE_ENV.invocationCap])
    for (const value of refused)
      assert.throws(
        () => liveOptionsFromEnv(scrubbed({ ...base, [name]: value }), blankArgs()),
        new RegExp(name),
      );
  assert.throws(
    () =>
      liveOptionsFromEnv(
        scrubbed({ ...base, [LIVE_ENV.warn]: "200", [LIVE_ENV.totalCap]: "150" }),
        blankArgs(),
      ),
    /less than or equal/,
  );
  const cachedZero = liveOptionsFromEnv(
    scrubbed({ ...base, [LIVE_ENV.priceCached]: "0" }),
    blankArgs(),
  );
  assert.equal(cachedZero.prices.cachedInputUsdPerMillion, 0);
  const directory = await tempLedger();
  let called = false;
  await assert.rejects(
    () =>
      runLiveBenchmark({
        seeds: [1],
        smoke: false,
        deployment: "gpt-5.4-mini",
        apiVersion: "v1",
        endpoint: "https://127.0.0.1/",
        apiKey: KEY,
        prices: { inputUsdPerMillion: 0, outputUsdPerMillion: 4.5, cachedInputUsdPerMillion: 0 },
        totalCapUsd: 10,
        warnUsd: 1,
        invocationCapUsd: 1,
        stopAtWarn: false,
        ledgerPath: join(directory, "ledger.json"),
        fetch: async () => {
          called = true;
          throw new Error("network");
        },
      }),
    /LOOPITER_BENCH_PRICE_INPUT_PER_1M/,
  );
  assert.equal(called, false);
  await assert.rejects(
    () =>
      runLiveBenchmark({
        seeds: [1],
        smoke: false,
        deployment: "gpt-5.4-mini",
        apiVersion: "v1",
        endpoint: "https://127.0.0.1/",
        apiKey: KEY,
        prices: pricesOf(1, Number.NaN, 0),
        totalCapUsd: 10,
        warnUsd: 1,
        invocationCapUsd: 1,
        stopAtWarn: false,
        ledgerPath: join(directory, "other.json"),
      }),
    /LOOPITER_BENCH_PRICE_OUTPUT_PER_1M/,
  );
  await assert.rejects(
    () =>
      runLiveBenchmark({
        seeds: [1],
        smoke: false,
        deployment: "gpt-5.4-mini",
        apiVersion: "v1",
        endpoint: "https://127.0.0.1/",
        apiKey: KEY,
        prices: pricesOf(1, 1, 0),
        totalCapUsd: 10,
        warnUsd: 11,
        invocationCapUsd: 1,
        stopAtWarn: false,
        ledgerPath: join(directory, "caps.json"),
      }),
    /less than or equal/,
  );
});

test("CLI refuses live without both gates and does not echo the key", () => {
  const missing = spawnCli(["--live"], scrubbed({ [LIVE_ENV.apiKey]: KEY }));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /LOOPITER_BENCH_ALLOW_LIVE/);
  assert.equal(`${missing.stdout}${missing.stderr}`.includes(KEY), false);
  const oldFlag = spawnCli(
    [],
    scrubbed({ LOOPITER_BENCHMARK_LIVE: "1", [LIVE_ENV.apiKey]: KEY }),
  );
  assert.equal(oldFlag.status, 2);
  assert.equal(`${oldFlag.stdout}${oldFlag.stderr}`.includes(KEY), false);
  const prices = spawnCli(
    ["--live"],
    scrubbed({
      [LIVE_ENV.allow]: "1",
      [LIVE_ENV.endpoint]: "https://example.openai.azure.com/",
      [LIVE_ENV.apiKey]: KEY,
    }),
  );
  assert.equal(prices.status, 2);
  assert.match(prices.stderr, /LOOPITER_BENCH_PRICE_INPUT_PER_1M/);
  assert.equal(`${prices.stdout}${prices.stderr}`.includes(KEY), false);
});

test("estimate makes no calls and prints smoke and full token totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kb-qa-estimate-"));
  const env = scrubbed({
    [LIVE_ENV.priceInput]: "0.75",
    [LIVE_ENV.priceOutput]: "4.5",
    [LIVE_ENV.apiKey]: KEY,
    [LIVE_ENV.endpoint]: "https://invalid.test/",
  });
  const text = estimateFromEnv(env);
  assert.match(text, /No provider calls were made/);
  assert.match(text, /input tokens: \d+/);
  assert.match(text, /output tokens: \d+/);
  assert.equal(text.includes(KEY), false);
  const rendered = renderEstimate(
    { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 },
  );
  assert.equal(text, rendered);
  const run = spawnCli(["--estimate"], env, directory);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, rendered);
  assert.equal(run.stdout.includes(KEY), false);
  await assert.rejects(readFile(join(directory, "reports/kb-qa-live/ledger.json")));
  const refused = spawnCli(["--estimate"], scrubbed({ [LIVE_ENV.apiKey]: KEY }), directory);
  assert.equal(refused.status, 2);
  assert.equal(`${refused.stdout}${refused.stderr}`.includes(KEY), false);
});

test("ledger spend survives a second open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kb-qa-ledger-"));
  const path = join(directory, "ledger.json");
  const prices = pricesOf(1, 2, 0.5);
  const caps = { totalMicroUsd: 1_000_000, invocationMicroUsd: 1_000_000, warnMicroUsd: 10 };
  const ledger = await LiveLedger.open(path, caps, prices);
  const worst = { input: 100, output: 64, cached: 0 };
  assert.equal(ledger.allow(worst, false), true);
  const held = await ledger.beginAttempt(worst);
  await ledger.finishAttempt(held, { input: 20, output: 5, cached: 4 }, true);
  const expected = liveCostMicroUsd({ input: 20, output: 5, cached: 4 }, prices);
  assert.equal(ledger.totalMicroUsd, expected);
  assert.equal(ledger.calls, 1);
  assert.equal(ledger.attempts, 1);
  const reopened = await LiveLedger.open(path, caps, prices);
  assert.equal(reopened.totalMicroUsd, expected);
  assert.equal(reopened.calls, 1);
  assert.equal(reopened.invocationMicroUsd, 0);
  assert.equal(reopened.warnCrossed, true);
  const again = await reopened.beginAttempt(worst);
  await reopened.finishAttempt(again, { input: 10, output: 1, cached: 0 }, false);
  const persisted = JSON.parse(await readFile(path, "utf8")) as { totalMicroUsd: number };
  assert.equal(persisted.totalMicroUsd, reopened.totalMicroUsd);
  assert.equal(JSON.stringify(persisted).includes(KEY), false);
  const invocation = await LiveLedger.open(join(directory, "invocation.json"), {
    totalMicroUsd: 5_000_000,
    invocationMicroUsd: 100,
    warnMicroUsd: 5_000_000,
  }, prices);
  assert.equal(invocation.allow({ input: 1000, output: 64, cached: 0 }, false), false);
  assert.equal(invocation.stopReason, "invocation_cap");
  assert.equal(invocation.attempts, 0);
});

test("pre-call cap stops before the next request and keeps a partial report", async () => {
  const plan = planLiveRun({
    label: "selected",
    seeds: [1],
    rowLimit: 2,
    deployment: "gpt-5.4-mini",
  });
  const first = plan.calls[0]!;
  const prices = pricesOf(1, 1, 1);
  const worst = Math.round(first.ceilingInputTokens * 1 + first.outputTokens * 1);
  assert.equal(usdToMicro(Number(formatUsd(worst))), worst);
  const server = await fakeServer(async () => ({
    status: 200,
    text: JSON.stringify({ label: "incomplete" }),
    usage: {
      input_tokens: first.ceilingInputTokens,
      output_tokens: first.outputTokens,
      cached_tokens: 0,
    },
  }));
  try {
    const report = await runLiveBenchmark({
      ...liveShape(server, await tempLedger()),
      prices,
      totalCapUsd: Number(formatUsd(worst)),
      invocationCapUsd: 100,
      warnUsd: Number(formatUsd(worst)),
      rowLimit: 2,
      seeds: [1],
    });
    assert.equal(server.requests.length, 1);
    assert.equal(report.stopped?.reason, "total_cap");
    assert.equal(report.passed, false);
    assert.equal(report.perSeed[0]?.candidate, null);
    assert.equal(JSON.stringify(report).includes(KEY), false);
    const body = JSON.parse(server.requests[0]!.body) as {
      max_output_tokens: number;
      reasoning?: { effort?: string };
    };
    assert.equal(body.max_output_tokens, PREDICT_MAX_OUTPUT_TOKENS);
    assert.equal(body.reasoning?.effort, "low");
    assert.equal(server.requests[0]!.url.includes("api-version=v1"), true);
  } finally {
    await server.close();
  }
});

test("warn marker is recorded and --stop-at-warn halts before another call", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  const server = await fakeServer(async () => ({
    status: 200,
    text: JSON.stringify({ label: "incomplete" }),
  }));
  try {
    const report = await runLiveBenchmark({
      ...liveShape(server, await tempLedger()),
      prices: pricesOf(1, 1, 1),
      totalCapUsd: 100,
      invocationCapUsd: 100,
      warnUsd: 0.000001,
      stopAtWarn: true,
      rowLimit: 2,
      seeds: [1],
    });
    assert.equal(server.requests.length, 1);
    assert.equal(report.warn.crossed, true);
    assert.match(report.warn.marker ?? "", /WARN/);
    assert.equal(report.stopped?.reason, "warn");
    assert.ok(warnings.some((line) => line.startsWith("WARN cumulative spend crossed")));
    assert.equal(JSON.stringify(report).includes(KEY), false);
    assert.ok(report.spend.totalMicroUsd >= 1);
  } finally {
    console.warn = original;
    await server.close();
  }
});

test("provider errors redact the key and do not echo request headers", async () => {
  const server = await fakeServer(async () => ({
    status: 400,
    text: JSON.stringify({ error: KEY, api_key: KEY }),
  }));
  try {
    const report = await runLiveBenchmark({
      ...liveShape(server, await tempLedger()),
      prices: pricesOf(1, 1, 1),
      totalCapUsd: 100,
      invocationCapUsd: 100,
      warnUsd: 100,
      rowLimit: 1,
      seeds: [1],
    });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.apiKey, KEY);
    assert.equal(report.stopped?.reason, "provider_error");
    const rendered = JSON.stringify(report);
    assert.equal(rendered.includes(KEY), false);
    assert.equal((report.stopped?.message ?? "").includes(KEY), false);
    assert.equal(report.passed, false);
  } finally {
    await server.close();
  }
});

test("end-to-end live path bills a fake HTTP server and persists the ledger", async () => {
  let attempts = 0;
  const server = await fakeServer(async (request) => {
    attempts += 1;
    const outer = JSON.parse(request.body) as {
      max_output_tokens: number;
      input: string;
      text: { format: { name: string } };
    };
    assert.equal(typeof outer.max_output_tokens, "number");
    assert.ok(outer.max_output_tokens > 0);
    const inner = JSON.parse(outer.input) as {
      guidance?: string;
      text?: string;
      fragment?: string;
      examples?: { question: string; label: string }[];
    };
    const text =
      outer.text.format.name === "bounded_prompt_revision"
        ? JSON.stringify({
            fragment: improveFragment(inner.fragment ?? baselineFragment(), inner.examples ?? []),
          })
        : JSON.stringify({
            label:
              inner.guidance === baselineFragment()
                ? "incomplete"
                : gold(inner.text ?? ""),
          });
    if (attempts === 1)
      return {
        status: 429,
        text: JSON.stringify({
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 4 },
          },
        }),
      };
    return { status: 200, text };
  });
  const directory = await tempLedger();
  try {
    const report = await runLiveBenchmark({
      ...liveShape(server, directory),
      prices: pricesOf(1, 1, 1),
      totalCapUsd: 100,
      invocationCapUsd: 100,
      warnUsd: 100,
      smoke: true,
      rowLimit: SMOKE_ROWS,
      seeds: [1],
    });
    assert.equal(report.stopped, null, JSON.stringify(report.stopped));
    assert.equal(report.passed, true);
    assert.equal(report.provider, "azure-openai");
    assert.equal(report.api, "responses");
    assert.equal(report.apiVersion, "v1");
    assert.ok(server.requests.length > 10);
    assert.equal(server.requests.every((item) => item.apiKey === KEY), true);
    assert.equal(
      server.requests.every((item) => item.url.includes("/openai/v1/responses?api-version=v1")),
      true,
    );
    assert.equal(report.attempts, report.liveCalls + 1);
    const perAttempt = liveCostMicroUsd({ input: 20, output: 5, cached: 4 }, pricesOf(1, 1, 1));
    assert.equal(report.spend.totalMicroUsd, report.attempts * perAttempt);
    assert.equal(report.spend.cachedInputTokens, report.attempts * 4);
    const reopened = await LiveLedger.open(
      join(directory, "ledger.json"),
      {
        totalMicroUsd: usdToMicro(100),
        invocationMicroUsd: usdToMicro(100),
        warnMicroUsd: usdToMicro(100),
      },
      pricesOf(1, 1, 1),
    );
    assert.equal(reopened.totalMicroUsd, report.spend.totalMicroUsd);
    assert.equal(reopened.invocationMicroUsd, 0);
    assert.equal(JSON.stringify(report).includes(KEY), false);
    for (const row of report.perSeed) {
      assert.equal(row.candidate?.state, "completed");
      assert.equal(row.baseline.rate, 0);
      assert.equal(row.candidate?.heldOut.rate, 1);
    }
  } finally {
    await server.close();
  }
});

test("reasoning effort, output bounds, and incomplete reasons stay on the fake server", async () => {
  assert.throws(
    () =>
      estimateFromEnv(
        scrubbed({
          [LIVE_ENV.priceInput]: "4",
          [LIVE_ENV.priceOutput]: "20",
          [LIVE_ENV.reasoning]: "turbo",
        }),
      ),
    /LOOPITER_BENCH_REASONING_EFFORT/,
  );
  assert.throws(
    () =>
      liveOptionsFromEnv(
        scrubbed({ ...readyEnv(), [LIVE_ENV.predictMax]: "0" }),
        blankArgs(),
      ),
    /LOOPITER_BENCH_PREDICT_MAX_OUTPUT_TOKENS/,
  );
  assert.throws(
    () =>
      liveOptionsFromEnv(
        scrubbed({ ...readyEnv(), [LIVE_ENV.proposeMax]: "1.5" }),
        blankArgs(),
      ),
    /LOOPITER_BENCH_PROPOSE_MAX_OUTPUT_TOKENS/,
  );
  const priced = scrubbed({
    [LIVE_ENV.priceInput]: "4",
    [LIVE_ENV.priceOutput]: "20",
    [LIVE_ENV.predictMax]: "128",
    [LIVE_ENV.proposeMax]: "333",
    [LIVE_ENV.reasoning]: "minimal",
  });
  const text = estimateFromEnv(priced);
  assert.match(text, /Reasoning effort: minimal/);
  assert.match(text, /Predict max output tokens: 128/);
  assert.match(text, /Propose max output tokens: 333/);
  const smoke = planLiveRun({
    label: "smoke",
    seeds: [1],
    rowLimit: SMOKE_ROWS,
    predictMaxOutputTokens: 128,
    proposeMaxOutputTokens: 333,
    reasoningEffort: "minimal",
  });
  assert.match(text, new RegExp(`output tokens: ${smoke.outputTokens}`));
  assert.equal(
    smoke.outputTokens,
    smoke.baselineCalls * 128 + 333 + (smoke.candidateCalls - 1) * 128,
  );

  const high = await fakeServer(async () => ({
    status: 200,
    text: "{}",
    raw: JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      leaked_key: KEY,
    }),
  }));
  try {
    const report = await runLiveBenchmark({
      ...liveShape(high, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      reasoningEffort: "high",
      predictMaxOutputTokens: 180,
    });
    assert.equal(high.requests.length, 1);
    const body = JSON.parse(high.requests[0]!.body) as {
      max_output_tokens: number;
      reasoning?: { effort?: string };
    };
    assert.equal(body.reasoning?.effort, "high");
    assert.equal(body.max_output_tokens, 180);
    assert.match(report.stopped?.message ?? "", /incomplete_details\.reason: max_output_tokens/);
    assert.equal((report.stopped?.message ?? "").includes(KEY), false);
    assert.equal((report.stopped?.message ?? "").includes("api-key"), false);
  } finally {
    await high.close();
  }

  const omitted = await fakeServer(async () => ({
    status: 200,
    text: JSON.stringify({ label: "incomplete" }),
  }));
  try {
    await runLiveBenchmark({
      ...liveShape(omitted, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      reasoningEffort: null,
      predictMaxOutputTokens: 90,
    });
    const body = JSON.parse(omitted.requests[0]!.body) as {
      max_output_tokens: number;
      reasoning?: unknown;
    };
    assert.equal(Object.hasOwn(body, "reasoning"), false);
    assert.equal(body.max_output_tokens, 90);
  } finally {
    await omitted.close();
  }
});

test("pacing and HTTP 429 retries stay on the fake server", async () => {
  for (const [name, value] of [
    [LIVE_ENV.maxTpm, "nope"],
    [LIVE_ENV.maxTpm, "-1"],
    [LIVE_ENV.maxTpm, "1.5"],
    [LIVE_ENV.maxTpm, ""],
    [LIVE_ENV.max429Retries, "0"],
    [LIVE_ENV.max429Retries, "NaN"],
    [LIVE_ENV.maxRetryWait, "0"],
    [LIVE_ENV.maxRetryWait, "-5"],
    [LIVE_ENV.requestTimeout, "0"],
    [LIVE_ENV.maxTotalWait, "0"],
  ] as const)
    assert.throws(
      () => liveOptionsFromEnv(scrubbed({ ...readyEnv(), [name]: value }), blankArgs()),
      new RegExp(name),
    );
  const disabled = liveOptionsFromEnv(
    scrubbed({ ...readyEnv(), [LIVE_ENV.maxTpm]: "0" }),
    blankArgs(),
  );
  assert.equal(disabled.maxTokensPerMinute, 0);

  const clock = fakeClock();
  const paced = await fakeServer(async () => ({
    status: 200,
    text: JSON.stringify({ label: "incomplete" }),
  }));
  try {
    const pacedReport = await runLiveBenchmark({
      ...liveShape(paced, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      maxTokensPerMinute: 1,
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    });
    assert.ok(paced.requests.length >= 2);
    assert.ok(clock.sleeps.some((ms) => ms >= 60_000));
    assert.equal(pacedReport.pacing.maxTokensPerMinute, 1);
    assert.ok(pacedReport.pacing.waitMs >= 60_000);
    assert.equal(JSON.stringify(pacedReport).includes(KEY), false);
  } finally {
    await paced.close();
  }

  const retryClock = fakeClock();
  let retryCalls = 0;
  const retried = await fakeServer(async () => {
    retryCalls += 1;
    if (retryCalls === 1)
      return {
        status: 429,
        text: JSON.stringify({ error: KEY }),
        headers: { "Retry-After": "30" },
      };
    return { status: 200, text: JSON.stringify({ label: "incomplete" }) };
  });
  try {
    const report = await runLiveBenchmark({
      ...liveShape(retried, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      maxRetryWaitMs: 4_000,
      max429Retries: 2,
      now: retryClock.now,
      sleep: retryClock.sleep,
      random: retryClock.random,
    });
    assert.equal(retryClock.sleeps[0], 4_000);
    assert.ok(report.pacing.rateLimitResponses >= 1);
    assert.ok(report.pacing.waitMs >= 4_000);
    assert.ok(report.attempts > report.liveCalls);
    assert.equal((report.stopped?.message ?? "").includes(KEY), false);
  } finally {
    await retried.close();
  }

  const plan = planLiveRun({
    label: "selected",
    seeds: [1],
    rowLimit: 1,
    deployment: "gpt-5.4-mini",
  });
  const first = plan.calls[0]!;
  const worst = Math.round(first.ceilingInputTokens + first.outputTokens);
  const capped = await fakeServer(async () => ({
    status: 429,
    text: "{}",
    headers: { "retry-after-ms": "2500" },
  }));
  const capClock = fakeClock();
  try {
    const report = await runLiveBenchmark({
      ...liveShape(capped, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: Number(formatUsd(worst)),
      invocationCapUsd: 100,
      warnUsd: Number(formatUsd(worst)),
      rowLimit: 1,
      seeds: [1],
      now: capClock.now,
      sleep: capClock.sleep,
      random: capClock.random,
    });
    assert.equal(capped.requests.length, 1);
    assert.equal(report.stopped?.reason, "total_cap");
    assert.equal(report.attempts, 1);
    assert.ok(report.spend.totalMicroUsd > 0);
    assert.equal(report.pacing.rateLimitResponses, 1);
    assert.equal(capClock.sleeps.length, 0);
  } finally {
    await capped.close();
  }

  const exhaustedClock = fakeClock();
  const exhausted = await fakeServer(async () => ({
    status: 429,
    text: JSON.stringify({ api_key: KEY }),
    headers: { "retry-after-ms": "1500" },
  }));
  try {
    const report = await runLiveBenchmark({
      ...liveShape(exhausted, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      max429Retries: 1,
      now: exhaustedClock.now,
      sleep: exhaustedClock.sleep,
      random: exhaustedClock.random,
    });
    assert.equal(exhausted.requests.length, 2);
    assert.equal(report.stopped?.reason, "rate_limit");
    assert.equal(report.passed, false);
    assert.equal(report.pacing.rateLimitResponses, 2);
    assert.equal(report.pacing.waitMs, 1_500);
    assert.equal(report.attempts, 2);
    assert.equal((report.stopped?.message ?? "").includes(KEY), false);
    assert.equal(JSON.stringify(report).includes(KEY), false);
    assert.equal((report.stopped?.message ?? "").includes("retry-after"), false);
  } finally {
    await exhausted.close();
  }
});

test("both retry headers prefer retry-after-ms and the retry is metered", async () => {
  const clock = fakeClock();
  let calls = 0;
  const server = await fakeServer(async () => {
    calls += 1;
    if (calls === 1)
      return {
        status: 429,
        text: JSON.stringify({ error: KEY }),
        headers: { "retry-after-ms": "2500", "Retry-After": "30" },
      };
    return { status: 200, text: JSON.stringify({ label: "incomplete" }) };
  });
  try {
    const report = await runLiveBenchmark({
      ...liveShape(server, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      maxRetryWaitMs: 60_000,
      max429Retries: 2,
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    });
    assert.equal(clock.sleeps[0], 2_500);
    assert.equal(clock.sleeps.includes(30_000), false);
    assert.equal(report.pacing.waitMs, 2_500);
    assert.equal(report.pacing.rateLimitResponses, 1);
    assert.ok(report.attempts > report.liveCalls);
    assert.ok(report.spend.totalMicroUsd > 0);
    assert.equal((report.stopped?.message ?? "").includes(KEY), false);
    assert.equal(JSON.stringify(report).includes(KEY), false);
  } finally {
    await server.close();
  }
});

test("request timeout is retried, and the wait watchdog stops the run", async () => {
  let hung = 0;
  const fetchTimeout: typeof fetch = async (_url, init) => {
    hung += 1;
    await new Promise<void>((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () =>
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      if (!signal) {
        fail();
        return;
      }
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    throw new Error("timed out request continued");
  };
  const report = await runLiveBenchmark({
    ...liveShape(
      { requests: [], fetch: fetchTimeout, close: async () => undefined },
      await tempLedger(),
    ),
    prices: pricesOf(1, 1, 0),
    totalCapUsd: 50,
    invocationCapUsd: 50,
    warnUsd: 40,
    rowLimit: 1,
    seeds: [1],
    requestTimeoutMs: 40,
  });
  assert.equal(hung, 2);
  assert.equal(report.attempts, 2);
  assert.equal(report.liveCalls, 0);
  assert.equal(report.passed, false);
  assert.match(report.stopped?.message ?? "", /timed out|Timeout/i);

  const clock = fakeClock();
  let limited = 0;
  const waiting = await fakeServer(async () => {
    limited += 1;
    return {
      status: 429,
      text: "{}",
      headers: { "retry-after-ms": "2000" },
    };
  });
  try {
    const report = await runLiveBenchmark({
      ...liveShape(waiting, await tempLedger()),
      prices: pricesOf(1, 1, 0),
      totalCapUsd: 50,
      invocationCapUsd: 50,
      warnUsd: 40,
      rowLimit: 1,
      seeds: [1],
      max429Retries: 5,
      maxRetryWaitMs: 60_000,
      maxTotalWaitMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    });
    assert.equal(limited, 2);
    assert.deepEqual(clock.sleeps, [2_000]);
    assert.equal(report.stopped?.reason, "wait_limit");
    assert.match(report.stopped?.message ?? "", /LOOPITER_BENCH_MAX_TOTAL_WAIT_SECONDS/);
    assert.equal(report.passed, false);
  } finally {
    await waiting.close();
  }
});

test("step deadline covers a retried evaluate call, and pace waits in one acquire share the cap", async () => {
  const callsPerStep = maxModelCallsPerStep();
  const requestTimeoutMs = 120_000;
  const maxTotalWaitMs = 900_000;
  const deadline = liveCallbackTimeoutMs({
    callsPerStep,
    requestTimeoutMs,
    max429Retries: 6,
    maxRetryWaitMs: 60_000,
    maxTotalWaitMs,
  });
  assert.equal(callsPerStep, 2);
  const plan = liveDeadlinePlan({
    callsPerStep,
    requestTimeoutMs,
    max429Retries: 6,
    maxRetryWaitMs: 60_000,
    maxTotalWaitMs,
  });
  assert.equal(deadline, plan.callbackTimeoutMs);
  assert.equal(plan.attemptDeadlineMs, 255_000);
  assert.equal(plan.callbackTimeoutMs, 4_920_000);
  assert.equal(MAX_STEP_MS, 7_200_000);
  assert.ok(plan.attemptDeadlineMs >= requestTimeoutMs + 75_000);
  assert.throws(
    () =>
      liveDeadlinePlan({
        callsPerStep,
        requestTimeoutMs: 600_000,
        max429Retries: 6,
        maxRetryWaitMs: 60_000,
        maxTotalWaitMs,
      }),
    /Refusing to start/,
  );
  const shrunkWaits = liveDeadlinePlan({
    callsPerStep,
    requestTimeoutMs: 300_000,
    max429Retries: 6,
    maxRetryWaitMs: 60_000,
    maxTotalWaitMs,
  });
  assert.equal(shrunkWaits.attemptDeadlineMs, 435_000);
  assert.equal(shrunkWaits.callbackTimeoutMs, MAX_STEP_MS);

  const clock = fakeClock();
  const directory = await tempLedger();
  const ledger = new LiveLedger(
    { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
    pricesOf(1, 1, 0),
    join(directory, "ledger.json"),
  );
  let fetches = 0;
  const session = new LiveSession(ledger, [], false, {
    endpoint: "https://example.openai.azure.com/",
    apiKey: KEY,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    fetch: async () => {
      fetches += 1;
      const input_tokens = fetches === 1 ? 55 : 35;
      return completedResponse({ label: "yes" }, { input_tokens, output_tokens: 5 });
    },
    maxTokensPerMinute: 112,
    maxRetryWaitMs: 1_000,
    max429Retries: 1,
    requestTimeoutMs: 1_000,
    maxTotalWaitMs: 50_000,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    predictMaxOutputTokens: 10,
    proposeMaxOutputTokens: 10,
    reasoningEffort: null,
  });
  const meter = async <T>(
    _maximum: number,
    call: () => Promise<{ value: T; tokens: number | null }>,
  ) => (await call()).value;
  const signal = new AbortController().signal;
  const ask = (bytes: number, output: number) =>
    session.generate(
      {
        instructions: "label",
        input: "{}",
        name: "classification",
        schema: { type: "object" },
      },
      "x".repeat(bytes),
      output,
      meter,
      signal,
    );
  await ask(200, 10);
  await clock.sleep(20_000);
  await ask(120, 10);
  await ask(204, 10);
  assert.equal(fetches, 3);
  assert.equal(session.waitLimitReached, false);
  assert.ok(session.waitMs >= 60_000);
  assert.deepEqual(clock.sleeps, [20_000, 40_000, 20_000]);

  let classification = 0;
  let retriedWhileLive = false;
  const retryFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      text?: { format?: { name?: string } };
      input?: string;
    };
    if (body.text?.format?.name === "classification") {
      classification += 1;
      if (classification === 2) {
        await new Promise<void>((_resolve, reject) => {
          const fail = () =>
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          if (!init?.signal || init.signal.aborted) fail();
          else init.signal.addEventListener("abort", fail, { once: true });
        });
      }
      if (classification === 3) retriedWhileLive = init?.signal?.aborted === false;
    }
    const inner = JSON.parse(body.input ?? "{}") as {
      guidance?: string;
      text?: string;
      fragment?: string;
      examples?: { question: string; label: string }[];
    };
    const payload =
      body.text?.format?.name === "bounded_prompt_revision"
        ? {
            fragment: improveFragment(inner.fragment ?? baselineFragment(), inner.examples ?? []),
          }
        : {
            label:
              inner.guidance === baselineFragment() ? "incomplete" : gold(inner.text ?? ""),
          };
    return completedResponse(payload);
  };
  const report = await runLiveBenchmark({
    ...liveShape(
      { requests: [], fetch: retryFetch, close: async () => undefined },
      await tempLedger(),
    ),
    prices: pricesOf(1, 1, 0),
    totalCapUsd: 50,
    invocationCapUsd: 50,
    warnUsd: 40,
    rowLimit: 1,
    seeds: [1],
    requestTimeoutMs: 40,
    max429Retries: 1,
    maxRetryWaitMs: 1_000,
    maxTotalWaitMs: 5_000,
  });
  const expected = liveCallbackTimeoutMs({
    callsPerStep,
    requestTimeoutMs: 40,
    max429Retries: 1,
    maxRetryWaitMs: 1_000,
    maxTotalWaitMs: 5_000,
  });
  assert.equal(report.pacing.callbackTimeoutMs, expected);
  assert.equal(report.pacing.tickTimeoutMs, expected + 1_000);
  assert.ok(report.pacing.callbackTimeoutMs > 40 * MAX_ATTEMPTS);
  assert.equal(retriedWhileLive, true);
  assert.ok(classification >= 3);
  assert.equal((report.stopped?.message ?? "").includes("Callback deadline exceeded"), false);
});

test("transient fetch failures retry within the attempt and wait caps", async () => {
  const clock = fakeClock();
  const directory = await tempLedger();
  const logs: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    logs.push(String(message));
  };
  const networkError = () => {
    const cause = new Error("socket reset");
    (cause as Error & { code: string }).code = "ECONNRESET";
    const error = new TypeError("fetch failed");
    (error as TypeError & { cause?: unknown }).cause = cause;
    return error;
  };
  try {
    let fetches = 0;
    const ledger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "recovered.json"),
    );
    const session = new LiveSession(ledger, [KEY], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch: async () => {
        fetches += 1;
        if (fetches === 1) throw networkError();
        return completedResponse({ label: "yes" });
      },
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 60_000,
      max429Retries: 1,
      requestTimeoutMs: 1_000,
      maxTotalWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    const meter = async <T>(
      _maximum: number,
      call: () => Promise<{ value: T; tokens: number | null }>,
    ) => (await call()).value;
    await session.generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    );
    assert.equal(fetches, 2);
    assert.equal(ledger.attempts, 2);
    assert.equal(ledger.calls, 1);
    assert.ok(ledger.totalMicroUsd > 0);
    assert.deepEqual(clock.sleeps, [1_000]);
    assert.match(logs.join("\n"), /retrying ECONNRESET/);
    assert.equal(logs.join("\n").includes(KEY), false);

    let refused = 0;
    const limited = new LiveLedger(
      { totalMicroUsd: 20, invocationMicroUsd: 100, warnMicroUsd: 10 },
      pricesOf(1, 1, 0),
      join(directory, "capped.json"),
    );
    const capped = new LiveSession(limited, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch: async () => {
        refused += 1;
        throw networkError();
      },
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 60_000,
      max429Retries: 1,
      requestTimeoutMs: 1_000,
      maxTotalWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    await assert.rejects(
      capped.generate(
        { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
        "xxxx",
        10,
        meter,
        new AbortController().signal,
      ),
      /LOOPITER_BENCH_TOTAL_CAP/,
    );
    assert.equal(refused, 1);
    assert.equal(limited.attempts, 1);
    assert.ok(limited.totalMicroUsd > 0);
    assert.equal(limited.stopReason, "total_cap");

    let exhausted = 0;
    const open = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "exhausted.json"),
    );
    const givingUp = new LiveSession(open, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch: async () => {
        exhausted += 1;
        throw networkError();
      },
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 60_000,
      max429Retries: 1,
      requestTimeoutMs: 1_000,
      maxTotalWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    await assert.rejects(
      givingUp.generate(
        { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
        "xxxx",
        10,
        meter,
        new AbortController().signal,
      ),
      /fetch failed|ECONNRESET|socket reset/i,
    );
    assert.equal(exhausted, MAX_ATTEMPTS);
    assert.equal(open.attempts, MAX_ATTEMPTS);

    const waitingClock = fakeClock();
    let waitedFetches = 0;
    const waitingLedger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "waiting.json"),
    );
    const waiting = new LiveSession(waitingLedger, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch: async () => {
        waitedFetches += 1;
        throw networkError();
      },
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 60_000,
      max429Retries: 1,
      requestTimeoutMs: 1_000,
      maxTotalWaitMs: 100,
      now: waitingClock.now,
      sleep: waitingClock.sleep,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    await assert.rejects(
      waiting.generate(
        { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
        "xxxx",
        10,
        meter,
        new AbortController().signal,
      ),
      /Retry wait for this call reached/,
    );
    assert.equal(waitedFetches, 1);
    assert.equal(waitingLedger.attempts, 1);
    assert.equal(waiting.waitLimitReached, true);
    assert.deepEqual(waitingClock.sleeps, []);

    let fatalFetches = 0;
    const fatalLedger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "fatal.json"),
    );
    const fatal = new LiveSession(fatalLedger, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch: async () => {
        fatalFetches += 1;
        if (fatalFetches === 1) throw new TypeError("Invalid URL");
        return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
      },
      maxTokensPerMinute: 1000,
      maxRetryWaitMs: 60_000,
      max429Retries: 1,
      requestTimeoutMs: 1_000,
      maxTotalWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    await assert.rejects(
      fatal.generate(
        { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
        "xxxx",
        10,
        meter,
        new AbortController().signal,
      ),
      /Invalid URL/,
    );
    assert.equal(fatalFetches, 1);
    await assert.rejects(
      fatal.generate(
        { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
        "xxxx",
        10,
        meter,
        new AbortController().signal,
      ),
      /HTTP 400/,
    );
    assert.equal(fatalFetches, 2);
    assert.equal(fatalLedger.attempts, 2);
    const paced = new TokenMinuteWindow(pacedTokenLimit(1000), clock.now, clock.sleep);
    const first = await paced.acquire(500);
    assert.equal(first.waited, 0);
    const second = await paced.acquire(500);
    assert.equal(second.waited, 60_000);
  } finally {
    console.error = original;
  }
});

test("a stalled provider and a stalled ledger stop on the attempt deadline", async () => {
  const directory = await tempLedger();
  const exits: number[] = [];
  const hung = await runLiveBenchmark({
    seeds: [1],
    smoke: false,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    endpoint: "https://example.openai.azure.com/",
    apiKey: KEY,
    prices: pricesOf(1, 1, 0),
    totalCapUsd: 50,
    invocationCapUsd: 50,
    warnUsd: 40,
    stopAtWarn: false,
    ledgerPath: join(directory, "hung.json"),
    rowLimit: 1,
    requestTimeoutMs: 5_000,
    maxRetryWaitMs: 1_000,
    max429Retries: 1,
    maxTotalWaitMs: 5_000,
    attemptDeadlineMs: 40,
    fetch: () => new Promise(() => undefined),
    exit: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  assert.equal(hung.stopped?.reason, "attempt_deadline");
  assert.match(hung.stopped?.message ?? "", /Attempt deadline exceeded/);

  const ledger = new LiveLedger(
    { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
    pricesOf(1, 1, 0),
    join(directory, "stalled-ledger.json"),
  );
  ledger.beginAttempt = () => new Promise(() => undefined);
  const session = new LiveSession(ledger, [], false, {
    endpoint: "https://example.openai.azure.com/",
    apiKey: KEY,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    fetch: async () => completedResponse({ label: "yes" }),
    maxTokensPerMinute: 0,
    maxRetryWaitMs: 1_000,
    max429Retries: 1,
    requestTimeoutMs: 1_000,
    maxTotalWaitMs: 5_000,
    attemptDeadlineMs: 40,
    now: () => Date.now(),
    sleep: async () => undefined,
    random: () => 0,
    predictMaxOutputTokens: 10,
    proposeMaxOutputTokens: 10,
    reasoningEffort: null,
  });
  const meter = async <T>(
    _maximum: number,
    call: () => Promise<{ value: T; tokens: number | null }>,
  ) => (await call()).value;
  await assert.rejects(
    session.generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    ),
    /Attempt deadline exceeded/,
  );

  let stalled = false;
  const watchdog = createStallWatchdog({
    intervalMs: 15,
    stallMs: 30,
    lastActivity: () => Date.now() - 1_000,
    onStall: () => {
      stalled = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  watchdog.stop();
  assert.equal(stalled, true);
  assert.equal(reservedAttemptsPerCall(6), MAX_ATTEMPTS + 6);
});

test("user abort, unauthorized, server, and lookup errors stay bounded", async () => {
  const directory = await tempLedger();
  const clock = fakeClock();
  const logs: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    logs.push(String(message));
  };
  const meter = async <T>(
    _maximum: number,
    call: () => Promise<{ value: T; tokens: number | null }>,
  ) => (await call()).value;
  const sessionFor = (fetch: typeof globalThis.fetch, ledgerName: string) => {
    const ledger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, ledgerName),
    );
    const session = new LiveSession(ledger, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch,
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 1_000,
      max429Retries: 1,
      requestTimeoutMs: 1_000,
      maxTotalWaitMs: 5_000,
      attemptDeadlineMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    return { ledger, session };
  };
  const ask = (session: LiveSession, signal = new AbortController().signal) =>
    session.generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      signal,
    );
  try {
    let lookups = 0;
    const lookup = sessionFor(async () => {
      lookups += 1;
      const cause = new Error("getaddrinfo");
      (cause as Error & { code: string }).code = "ENOTFOUND";
      const error = new TypeError("fetch failed");
      (error as TypeError & { cause?: unknown }).cause = cause;
      throw error;
    }, "lookup.json");
    await assert.rejects(ask(lookup.session), /fetch failed/);
    assert.equal(lookups, 1);
    assert.equal(lookup.ledger.attempts, 1);

    let certs = 0;
    const certificate = sessionFor(async () => {
      certs += 1;
      const cause = new Error("certificate");
      (cause as Error & { code: string }).code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
      const error = new TypeError("fetch failed");
      (error as TypeError & { cause?: unknown }).cause = cause;
      throw error;
    }, "cert.json");
    await assert.rejects(ask(certificate.session), /fetch failed/);
    assert.equal(certs, 1);

    const parent = new AbortController();
    let aborted = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancellable = sessionFor((_url, init) => {
      aborted += 1;
      entered();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
          { once: true },
        );
      });
    }, "abort.json");
    const pending = ask(cancellable.session, parent.signal);
    await started;
    parent.abort();
    await assert.rejects(pending, /aborted|Cancelled/);
    assert.equal(aborted, 1);

    let denied = 0;
    const unauthorized = sessionFor(async () => {
      denied += 1;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }, "unauthorized.json");
    await assert.rejects(ask(unauthorized.session), /HTTP 401/);
    assert.equal(denied, 1);
    assert.equal(unauthorized.ledger.attempts, 1);

    let serverErrors = 0;
    const server = sessionFor(async () => {
      serverErrors += 1;
      if (serverErrors === 1)
        return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      return completedResponse({ label: "yes" });
    }, "server.json");
    await ask(server.session);
    assert.equal(serverErrors, 2);
    assert.equal(server.ledger.attempts, 2);
    assert.match(logs.join("\n"), /retrying HTTP 503/);
    assert.equal(logs.join("\n").includes("no automatic retry"), false);
  } finally {
    console.error = original;
  }
});

test("exit guard, late abort, hung body, and pacing stall", async () => {
  const exits: number[] = [];
  const guard = createExitGuard((code) => exits.push(code));
  guard.arm(1, () => new Promise(() => undefined), 30);
  guard.arm(130, async () => undefined, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(exits, [1]);

  const together: number[] = [];
  const shared = createExitGuard((code) => together.push(code));
  let releaseWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  shared.arm(1, () => writing, 1_000);
  shared.arm(130, async () => undefined, 1_000);
  releaseWrite();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(together, [1]);

  const directory = await tempLedger();
  const ledger = new LiveLedger(
    { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
    pricesOf(1, 1, 0),
    join(directory, "late.json"),
  );
  let fetches = 0;
  const session = new LiveSession(ledger, [], false, {
    endpoint: "https://example.openai.azure.com/",
    apiKey: KEY,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    fetch: async () => {
      fetches += 1;
      return completedResponse({ label: "yes" });
    },
    maxTokensPerMinute: 0,
    maxRetryWaitMs: 1_000,
    max429Retries: 1,
    requestTimeoutMs: 1_000,
    maxTotalWaitMs: 5_000,
    attemptDeadlineMs: 5_000,
    now: () => Date.now(),
    sleep: async () => undefined,
    random: () => 0,
    predictMaxOutputTokens: 10,
    proposeMaxOutputTokens: 10,
    reasoningEffort: null,
  });
  const realBegin = ledger.beginAttempt.bind(ledger);
  const parent = new AbortController();
  ledger.beginAttempt = async (tokens) => {
    const held = await realBegin(tokens);
    parent.abort();
    return held;
  };
  const meter = async <T>(
    _maximum: number,
    call: () => Promise<{ value: T; tokens: number | null }>,
  ) => (await call()).value;
  await assert.rejects(
    session.generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      parent.signal,
    ),
    /aborted|Cancelled/,
  );
  assert.equal(fetches, 0);
  assert.equal(ledger.attempts, 0);
  assert.equal(ledger.totalMicroUsd, 0);

  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"status":"completed","output":[');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const bodyLedger = new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "body.json"),
    );
    const bodySession = new LiveSession(bodyLedger, [], false, {
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      deployment: "gpt-5.4-mini",
      apiVersion: "v1",
      fetch: (_url, init) =>
        fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          body: "{}",
          ...(init?.signal ? { signal: init.signal } : {}),
        }),
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 1_000,
      max429Retries: 1,
      requestTimeoutMs: 5_000,
      maxTotalWaitMs: 5_000,
      attemptDeadlineMs: 80,
      now: () => Date.now(),
      sleep: async () => undefined,
      random: () => 0,
      predictMaxOutputTokens: 10,
      proposeMaxOutputTokens: 10,
      reasoningEffort: null,
    });
    await assert.rejects(
      bodySession.generate(
        { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
        "xxxx",
        10,
        meter,
        new AbortController().signal,
      ),
      /Attempt deadline exceeded|aborted|timeout/i,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const paceLedger = new LiveLedger(
    { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
    pricesOf(1, 1, 0),
    join(directory, "pace.json"),
  );
  const paceSession = new LiveSession(paceLedger, [], false, {
    endpoint: "https://example.openai.azure.com/",
    apiKey: KEY,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    fetch: async () => completedResponse({ label: "yes" }, { input_tokens: 80, output_tokens: 10 }),
    maxTokensPerMinute: 112,
    maxRetryWaitMs: 1_000,
    max429Retries: 1,
    requestTimeoutMs: 5_000,
    maxTotalWaitMs: 60_000,
    attemptDeadlineMs: 200,
    now: () => 1_000,
    sleep: () => new Promise(() => undefined),
    random: () => 0,
    predictMaxOutputTokens: 10,
    proposeMaxOutputTokens: 10,
    reasoningEffort: null,
  });
  await paceSession.generate(
    { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
    "x".repeat(200),
    10,
    meter,
    new AbortController().signal,
  );
  let pacedOut = false;
  const paceWatch = createStallWatchdog({
    intervalMs: 15,
    stallMs: 40,
    lastActivity: () => paceSession.lastActivityMs,
    onStall: () => {
      pacedOut = true;
    },
  });
  const second = paceSession.generate(
    { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
    "x".repeat(200),
    10,
    meter,
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  paceWatch.stop();
  assert.equal(pacedOut, true);
  assert.equal(paceSession.inFlight > 0, true);
  void second.catch(() => undefined);
});

test("cause codes, one timeout sentence, and a retry wait that does not look stalled", async () => {
  const directory = await tempLedger();
  const meter = async <T>(
    _maximum: number,
    call: () => Promise<{ value: T; tokens: number | null }>,
  ) => (await call()).value;
  const base = {
    endpoint: "https://example.openai.azure.com/",
    apiKey: KEY,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    maxTokensPerMinute: 0,
    maxRetryWaitMs: 1_000,
    max429Retries: 1,
    requestTimeoutMs: 1_000,
    maxTotalWaitMs: 5_000,
    now: () => Date.now(),
    sleep: async () => undefined,
    random: () => 0,
    predictMaxOutputTokens: 10,
    proposeMaxOutputTokens: 10,
    reasoningEffort: null,
  } as const;
  let lookups = 0;
  const lookup = new LiveSession(
    new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "lookup.json"),
    ),
    [KEY],
    false,
    {
      ...base,
      fetch: async () => {
        lookups += 1;
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(`getaddrinfo ENOTFOUND example.openai.azure.com ${KEY}`), {
            code: "ENOTFOUND",
          }),
        });
      },
    },
  );
  await assert.rejects(
    lookup.generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    ),
    /fetch failed: ENOTFOUND getaddrinfo ENOTFOUND/,
  );
  assert.equal(lookups, 1);
  const lookupError = await lookup
    .generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  assert.match(String((lookupError as Error).message), /\[redacted\]/);
  assert.equal(String((lookupError as Error).message).includes(KEY), false);

  const timed = new LiveSession(
    new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "timeout.json"),
    ),
    [],
    false,
    {
      ...base,
      requestTimeoutMs: 80,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
  );
  const timeoutError = await timed
    .generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  const timeoutMessage = (timeoutError as Error).message;
  assert.equal(timeoutMessage.split("Request timed out after 80 ms.").length - 1, 1);

  const capped = new LiveSession(
    new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "cap.json"),
    ),
    [],
    false,
    {
      ...base,
      maxTotalWaitMs: 2_500,
      maxRetryWaitMs: 2_000,
      max429Retries: 4,
      fetch: async () => new Response("{}", { status: 429, headers: { "retry-after-ms": "2000" } }),
    },
  );
  const capError = await capped
    .generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  assert.match((capError as Error).message, /2\.5 seconds/);
  assert.equal((capError as Error).message.includes("(3 seconds)"), false);

  let quietStalled = false;
  const quiet = new LiveSession(
    new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "quiet.json"),
    ),
    [],
    false,
    {
      ...base,
      max429Retries: 2,
      maxRetryWaitMs: 1_000,
      attemptDeadlineMs: 2_000,
      fetch: async () => new Response("{}", { status: 429, headers: { "retry-after-ms": "500" } }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );
  const quietWatch = createStallWatchdog({
    intervalMs: 15,
    stallMs: 40,
    lastActivity: () => quiet.activityMs(),
    onStall: () => {
      quietStalled = true;
    },
  });
  const quietResult = quiet
    .generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 250));
  quietWatch.stop();
  assert.equal(quietStalled, false);
  await quietResult;

  let hungRetry = false;
  const hung = new LiveSession(
    new LiveLedger(
      { totalMicroUsd: 50_000_000, invocationMicroUsd: 50_000_000, warnMicroUsd: 40_000_000 },
      pricesOf(1, 1, 0),
      join(directory, "hung-retry.json"),
    ),
    [],
    false,
    {
      ...base,
      max429Retries: 2,
      maxRetryWaitMs: 1_000,
      attemptDeadlineMs: 400,
      fetch: async () => new Response("{}", { status: 429, headers: { "retry-after-ms": "30" } }),
      sleep: () => new Promise(() => undefined),
    },
  );
  const hungWatch = createStallWatchdog({
    intervalMs: 15,
    stallMs: 40,
    lastActivity: () => hung.activityMs(),
    onStall: () => {
      hungRetry = true;
    },
  });
  const hungResult = hung
    .generate(
      { instructions: "label", input: "{}", name: "classification", schema: { type: "object" } },
      "xxxx",
      10,
      meter,
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 120));
  hungWatch.stop();
  assert.equal(hungRetry, true);
  await hungResult;
});

test("pace reservation settles to actual tokens", async () => {
  const clock = fakeClock();
  const window = new TokenMinuteWindow(100, clock.now, clock.sleep);
  const first = await window.acquire(80);
  assert.equal(first.waited, 0);
  window.settle(first.id, 30);
  assert.equal(window.reservedTokens(), 30);
  const second = await window.acquire(60);
  assert.equal(second.waited, 0);
  assert.equal(clock.sleeps.length, 0);
  window.settle(second.id, 90);
  assert.equal(window.reservedTokens(), 120);
  const third = await window.acquire(1);
  assert.equal(third.waited, 60_000);
  assert.equal(clock.sleeps[0], 60_000);
});

test("progress ticker prints while waiting, and SIGINT writes a partial report", async () => {
  const lines: string[] = [];
  const ticker = startProgressTicker(20, () => {
    lines.push(formatProgress({ calls: 4, spendUsd: "0.25", state: "waiting on retry" }));
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines[0] ?? "", /progress calls=4 spend=0.25 USD state=waiting on retry/);
  } finally {
    ticker.stop();
  }

  const directory = await mkdtemp(join(tmpdir(), "kb-qa-interrupt-"));
  const ledgerPath = join(directory, "ledger.json");
  const reportPath = join(directory, "report.json");
  const prices = pricesOf(1, 2, 0);
  const ledger = await LiveLedger.open(ledgerPath, {
    totalMicroUsd: 1_000_000,
    invocationMicroUsd: 1_000_000,
    warnMicroUsd: 1_000_000,
  }, prices);
  await ledger.beginAttempt({ input: 10, output: 4, cached: 0 });
  const exits: number[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const handler = createInterruptHandler({
    ledger,
    reportPath,
    secrets: [KEY],
    perSeed: [
      {
        seed: 2,
        baseline: { successes: 3, scored: 4, trials: 4, rate: 0.75, complete: true },
        candidate: null,
      },
    ],
    guard: createExitGuard((code) => {
      exits.push(code);
      finished();
    }),
  });
  handler("SIGINT");
  await done;
  assert.deepEqual(exits, [130]);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    status: string;
    interrupted: boolean;
    stopped: { reason: string };
    spend: { attempts: number };
    perSeed?: {
      seed: number;
      baseline: { complete: boolean };
      candidate: unknown;
    }[];
  };
  assert.equal(report.status, "partial");
  assert.equal(report.interrupted, true);
  assert.equal(report.stopped.reason, "interrupted");
  assert.equal(report.spend.attempts, 1);
  assert.equal(report.perSeed?.[0]?.seed, 2);
  assert.equal(report.perSeed?.[0]?.baseline.complete, true);
  assert.equal(report.perSeed?.[0]?.candidate, null);
  const stored = JSON.parse(await readFile(ledgerPath, "utf8")) as { attempts: number };
  assert.equal(stored.attempts, 1);
  assert.equal(JSON.stringify(report).includes(KEY), false);
});

test("estimate wall time uses the realistic pace, not the spend ceiling", () => {
  const env = scrubbed({
    [LIVE_ENV.priceInput]: "0.75",
    [LIVE_ENV.priceOutput]: "4.5",
    [LIVE_ENV.maxTpm]: "50000",
  });
  const text = estimateFromEnv(env);
  const smoke = planLiveRun({
    label: "smoke",
    seeds: [1],
    rowLimit: SMOKE_ROWS,
  });
  const realistic = smoke.inputTokens + smoke.outputTokens;
  const ceiling = smoke.ceilingInputTokens + smoke.outputTokens;
  assert.ok(realistic < ceiling);
  const minutes = (projectedWallMs(smoke.calls, pacedTokenLimit(50_000)) / 60_000).toFixed(2);
  assert.equal(PACE_HEADROOM, 0.9);
  assert.equal(pacedTokenLimit(50_000), 45_000);
  assert.equal(pacedTokenLimit(1), 1);
  assert.equal(pacedTokenLimit(0), 0);
  assert.match(text, new RegExp(`pace tokens: ${realistic}`));
  assert.match(text, new RegExp(`projected wall minutes: ${minutes}`));
  assert.match(estimateFromEnv(scrubbed({
    [LIVE_ENV.priceInput]: "0.75",
    [LIVE_ENV.priceOutput]: "4.5",
  })), /projected wall minutes: pacing off/);
});

function completedResponse(
  payload: { label?: string; fragment?: string },
  usage = { input_tokens: 20, output_tokens: 5 },
): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      model: "gpt-5.4-mini",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(payload) }],
        },
      ],
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fakeClock() {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0,
  };
}

function blankArgs() {
  return {
    seeds: [1],
    smoke: false,
    stopAtWarn: false,
    ledgerPath: "reports/kb-qa-live/ledger.json",
  };
}

function pricedEnv(): Record<string, string> {
  return {
    [LIVE_ENV.allow]: "1",
    [LIVE_ENV.endpoint]: "https://example.openai.azure.com/",
    [LIVE_ENV.apiKey]: KEY,
    [LIVE_ENV.priceInput]: "0.75",
    [LIVE_ENV.priceOutput]: "4.5",
    [LIVE_ENV.priceCached]: "0.075",
  };
}

function readyEnv(): Record<string, string> {
  return {
    ...pricedEnv(),
    [LIVE_ENV.totalCap]: "150",
    [LIVE_ENV.warn]: "100",
    [LIVE_ENV.invocationCap]: "25",
  };
}

function pricesOf(input: number, output: number, cached: number): LivePrices {
  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    cachedInputUsdPerMillion: cached,
  };
}

async function tempLedger(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kb-qa-live-"));
}

function liveShape(server: FakeServer, directory: string) {
  return {
    seeds: [1],
    smoke: false,
    deployment: "gpt-5.4-mini",
    apiVersion: "v1",
    endpoint: "https://127.0.0.1/",
    apiKey: KEY,
    stopAtWarn: false,
    ledgerPath: join(directory, "ledger.json"),
    fetch: server.fetch,
  };
}

function gold(question: string): string {
  if (question.includes("per diem")) return "40 usd";
  if (question.includes("access token")) return "facilities desk";
  if (question.includes("home address") || question.includes("share price"))
    return "out of scope";
  if (question.includes("combine")) {
    const matched = FACTS.filter((fact) => question.includes(fact.keyword));
    return `${matched[0]?.gold} and ${matched[1]?.gold}`;
  }
  return FACTS.find((fact) => question.includes(fact.keyword))?.gold ?? "incomplete";
}

interface RecordedRequest {
  url: string;
  apiKey: string | null;
  body: string;
}

interface FakeServer {
  requests: RecordedRequest[];
  fetch: typeof fetch;
  close: () => Promise<void>;
}

async function fakeServer(
  respond: (
    request: RecordedRequest,
  ) => Promise<{
    status: number;
    text: string;
    raw?: string;
    headers?: Record<string, string>;
    usage?: { input_tokens: number; output_tokens: number; cached_tokens: number };
  }>,
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const recorded = {
      url: req.url ?? "",
      apiKey: req.headers["api-key"]?.toString() ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(recorded);
    const response = await respond(recorded);
    const headers = {
      "content-type": "application/json",
      ...response.headers,
    };
    if (response.raw) {
      res.writeHead(response.status, headers);
      res.end(response.raw);
      return;
    }
    if (response.status === 200) {
      const payload = JSON.parse(response.text) as { fragment?: string; label?: string };
      const usage = response.usage ?? {
        input_tokens: 20,
        output_tokens: 5,
        cached_tokens: 4,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "completed",
          model: "gpt-5.4-mini",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(payload) }],
            },
          ],
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
            input_tokens_details: { cached_tokens: usage.cached_tokens },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      );
      return;
    }
      res.writeHead(response.status, headers);
      res.end(response.text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake server has no port.");
  const port = address.port;
  return {
    requests,
    fetch: (async (url, init) => {
      const target = new URL(String(url));
      target.protocol = "http:";
      target.host = `127.0.0.1:${port}`;
      return fetch(target, init);
    }) as typeof fetch,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
