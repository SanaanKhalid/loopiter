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
  SMOKE_ROWS,
  estimateFromEnv,
  liveCostMicroUsd,
  liveOptionsFromEnv,
  planLiveRun,
  redactSecrets,
  renderEstimate,
  runLiveBenchmark,
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
    smoke.baselineCalls * 64 + 512 + (smoke.candidateCalls - 1) * 64,
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
    usage: { input_tokens: first.ceilingInputTokens, output_tokens: 64, cached_tokens: 0 },
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
    const body = JSON.parse(server.requests[0]!.body) as { max_output_tokens: number };
    assert.equal(body.max_output_tokens, 64);
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
    res.writeHead(response.status, { "content-type": "application/json" });
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
