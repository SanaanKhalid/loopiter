import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateChange } from "../../src/index.js";
import { closeVerifier, scoreWithVerifiers } from "../ifbench/score.js";
import {
  IFBENCH_TEST_REVISION,
  IFBENCH_TRAIN_REVISION,
  IFBENCH_VERIFIER_SHA,
} from "../ifbench/pins.js";
import { ifbenchTask } from "../ifbench/task.js";
import type { BenchmarkTask, PublicExample } from "./task.js";
import { exactMatch, normalizeAnswer, tokenF1 } from "../hotpotqa/normalize.js";
import { HOTPOT_EVAL_SHA, HOTPOT_REVISION } from "../hotpotqa/pins.js";
import { hotpotTask } from "../hotpotqa/task.js";
import {
  FIXTURE_SIZES,
  FULL_AUDIT_ROWS,
  PRODUCT_MINIMUM_IMPROVEMENT,
  PROMPT_CAP,
  observedGainRequired,
} from "./constants.js";
import { planTask } from "./estimate.js";
import { resolveLimits } from "./limits.js";
import { runOfflineBenchmark } from "./harness.js";
import { leakedIds, mockRunner, runOneShot } from "./loop.js";
import { promptPolicy } from "./policy.js";
import { repoRoot } from "./paths.js";
import { buildSeededSplit, idsOf, poolDatasetRow, type HeldOutRow, type PoolRow } from "./splits.js";

test.after(async () => {
  await closeVerifier();
});

type NotAssignable<A, B> = A extends B ? false : true;
const heldOutIsNotAPoolRow: NotAssignable<
  HeldOutRow<{ id: string }>,
  PoolRow<{ id: string }>
> = true;
void heldOutIsNotAPoolRow;

test("held-out rows stay out of every pool partition", () => {
  const pool = Array.from({ length: 16 }, (_, index) => ({ id: `p${index}` }));
  const heldOut = Array.from({ length: 4 }, (_, index) => ({ id: `h${index}` }));
  const sizes = { optimization: 4, validation: 4, audit: 4, production: 4, heldOut: 4 };
  let first = "";
  for (const seed of [1, 2, 3, 4, 5]) {
    const split = buildSeededSplit({ pool, heldOut, seed, sizes });
    const poolIds = new Set(
      [...split.optimization, ...split.validation, ...split.audit, ...split.production].map(
        (row) => row.example.id,
      ),
    );
    for (const row of split.heldOut) assert.equal(poolIds.has(row.example.id), false);
    assert.deepEqual(
      split.heldOut.map((row) => row.example.id),
      ["h0", "h1", "h2", "h3"],
    );
    const signature = split.optimization.map((row) => row.example.id).join(",");
    if (seed === 1) first = signature;
    if (seed === 2) assert.notEqual(signature, first);
  }
  assert.throws(() =>
    buildSeededSplit({
      pool: [{ id: "shared" }, { id: "b" }, { id: "c" }, { id: "d" }],
      heldOut: [{ id: "shared" }],
      seed: 1,
      sizes: { optimization: 1, validation: 1, audit: 1, production: 1, heldOut: 1 },
    }),
  );
  assert.throws(() =>
    poolDatasetRow(
      { role: "held-out", example: { id: "h0" } } as unknown as PoolRow<{ id: string }>,
      { text: "no" },
      "no",
    ),
  );
});

test("IFBench verifier bridge scores the fixtures", async () => {
  const pass = await scoreWithVerifiers([
    {
      prompt: "Include the keyword.",
      response: "quartz is here",
      instructionIdList: ["keywords:existence"],
      kwargs: [{ keywords: ["quartz"] }],
    },
  ]);
  const fail = await scoreWithVerifiers([
    {
      prompt: "Include the keyword.",
      response: "plain reply",
      instructionIdList: ["keywords:existence"],
      kwargs: [{ keywords: ["quartz"] }],
    },
  ]);
  const looseOnly = await scoreWithVerifiers([
    {
      prompt: "Include the keyword.",
      response: "quar*tz",
      instructionIdList: ["keywords:existence"],
      kwargs: [{ keywords: ["quartz"] }],
    },
  ]);
  const partial = await scoreWithVerifiers([
    {
      prompt: "Include both keywords.",
      response: "quartz only",
      instructionIdList: ["keywords:existence", "keywords:existence"],
      kwargs: [{ keywords: ["quartz"] }, { keywords: ["pebble"] }],
    },
  ]);
  assert.equal(pass[0]?.primary, 1);
  assert.equal(pass[0]?.loose, 1);
  assert.equal(fail[0]?.primary, 0);
  assert.equal(looseOnly[0]?.primary, 0);
  assert.equal(looseOnly[0]?.loose, 1);
  assert.equal(partial[0]?.primary, 0);
  assert.equal(partial[0]?.instructionStrictPasses, 1);
  assert.equal(partial[0]?.instructionStrictTotal, 2);
});

test("HotpotQA normalization matches the official EM and F1 rules", () => {
  assert.equal(normalizeAnswer("The Paris!"), "paris");
  assert.equal(exactMatch("The Paris!", "paris"), true);
  assert.equal(exactMatch("Paris, France", "Paris France"), true);
  assert.equal(exactMatch("yes", "no"), false);
  assert.equal(tokenF1("yes", "no"), 0);
  assert.equal(tokenF1("yes", "yes"), 1);
  assert.equal(tokenF1("unknown", "Paris"), 0);
  const overlap = tokenF1("Paris France", "Paris");
  assert.ok(overlap > 0 && overlap < 1);
});

test("one-shot applies a harmful rewrite with no gates", async () => {
  await assertHarmfulOneShot(ifbenchTask);
  await assertHarmfulOneShot(hotpotTask);
});

test("the validation gate rejects a harmful candidate and the product gate still rolls back", async () => {
  await assertRegression(ifbenchTask);
  await assertRegression(hotpotTask);
});

test("minimumImprovement is recorded and a value the audit cannot clear is refused", async () => {
  const report = await runOfflineBenchmark(ifbenchTask, {
    seeds: [1],
    source: "fixtures",
    minimumImprovement: 1,
  });
  assert.equal(report.minimumImprovement, 1);
  assert.equal(report.regressionMinimumImprovement, PRODUCT_MINIMUM_IMPROVEMENT);
  assert.equal(report.regression.passed, true);
  assert.equal(report.perSeed[0]?.controller.state, "waiting_for_evidence");
  assert.equal(report.perSeed[0]?.controller.reason, "invalid_policy");
  const required = observedGainRequired({
    auditRows: FULL_AUDIT_ROWS,
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
  });
  assert.ok(required > 0.19 && required < 0.2);
});

test("the prompt cap is larger than 800 characters and enforced", () => {
  const policy = promptPolicy({
    taskId: "ifbench",
    promptCap: PROMPT_CAP,
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    sizes: FIXTURE_SIZES,
    latencyMs: 1000,
    predictReservation: 1,
    proposeReservation: 1,
    batchSize: 1,
    observeChunk: 1,
  });
  assert.equal(policy.changeSchema.properties?.fragment?.maxLength, 8000);
  assert.ok(8000 > 800);
  validateChange({ fragment: "a".repeat(8000) }, policy.changeSchema);
  assert.throws(() => validateChange({ fragment: "a".repeat(8001) }, policy.changeSchema));
  assert.equal(ifbenchTask.predict.defaultValue, 2048);
  assert.equal(hotpotTask.predict.defaultValue, 1024);
  assert.equal(ifbenchTask.predict.min, 1024);
  assert.equal(ifbenchTask.predict.max, 2048);
  assert.throws(() => resolveLimits({ LOOPITER_BENCH_PREDICT_MAX_OUTPUT_TOKENS: "256" }, ifbenchTask));
  const limits = resolveLimits({}, ifbenchTask);
  assert.equal(limits.predictMaxOutputTokens, 2048);
  assert.equal(limits.proposeMaxOutputTokens, 2048);
});

test("estimate prints a per-arm plan for both datasets", () => {
  const root = repoRoot(import.meta.url);
  const env = scrubbed({
    LOOPITER_BENCH_PRICE_INPUT_PER_1M: "1",
    LOOPITER_BENCH_PRICE_OUTPUT_PER_1M: "2",
    AZURE_OPENAI_API_KEY: "super-secret-key-value",
  });
  const combined = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./estimate-main.js", import.meta.url))],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(combined.status, 0, combined.stderr);
  assert.match(combined.stdout, /IFBench live estimate/);
  assert.match(combined.stdout, /HotpotQA live estimate/);
  assert.match(combined.stdout, /No provider calls were made/);
  assert.match(combined.stdout, /baseline/);
  assert.match(combined.stdout, /one-shot/);
  assert.match(combined.stdout, /controller/);
  assert.equal(combined.stdout.includes("super-secret-key-value"), false);
  assert.equal(combined.stderr.includes("super-secret-key-value"), false);
  const ifbench = planTask(ifbenchTask, {
    label: "full",
    seeds: [1, 2, 3, 4, 5],
    sizes: ifbenchTask.fullSizes,
    limits: resolveLimits({}, ifbenchTask),
    deployment: "gpt-5.4-mini",
  });
  const hotpot = planTask(hotpotTask, {
    label: "full",
    seeds: [1, 2, 3, 4, 5],
    sizes: hotpotTask.fullSizes,
    limits: resolveLimits({}, hotpotTask),
    deployment: "gpt-5.4-mini",
  });
  assert.equal(ifbench.arms.baseline.length, 1500);
  assert.equal(ifbench.arms["one-shot"].length, 2255);
  assert.equal(ifbench.arms.controller.length, 9005);
  assert.equal(hotpot.arms.baseline.length, 1500);
  assert.equal(hotpot.arms["one-shot"].length, 1505);
  assert.equal(hotpot.arms.controller.length, 8255);
  assert.match(combined.stdout, /calls: 9005/);
  assert.match(combined.stdout, /calls: 8255/);
  assert.match(combined.stdout, /Predict max output tokens: 2048/);
  assert.match(combined.stdout, /Predict max output tokens: 1024/);
  for (const script of ["../ifbench/run.js", "../hotpotqa/run.js"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), "--estimate"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /one-shot/);
    assert.match(result.stdout, /controller/);
    assert.equal(result.stdout.includes("super-secret-key-value"), false);
  }
});

test("live mode refuses without the allow flag", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../ifbench/run.js", import.meta.url)), "--live"],
    {
      cwd: repoRoot(import.meta.url),
      env: scrubbed({ AZURE_OPENAI_API_KEY: "super-secret-key-value" }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /LOOPITER_BENCH_ALLOW_LIVE/);
  assert.equal(`${result.stdout}${result.stderr}`.includes("super-secret-key-value"), false);
});

test("fetch scripts and the bridge cite the pinned revisions", () => {
  const root = repoRoot(import.meta.url);
  const ifbenchFetch = readFileSync(`${root}/benchmarks/ifbench/fetch.py`, "utf8");
  const hotpotFetch = readFileSync(`${root}/benchmarks/hotpotqa/fetch.py`, "utf8");
  const bridge = readFileSync(`${root}/benchmarks/ifbench/bridge.py`, "utf8");
  const requirements = readFileSync(`${root}/benchmarks/ifbench/requirements.txt`, "utf8");
  assert.match(ifbenchFetch, new RegExp(IFBENCH_TEST_REVISION));
  assert.match(ifbenchFetch, new RegExp(IFBENCH_TRAIN_REVISION));
  assert.match(ifbenchFetch, /CI/);
  assert.match(hotpotFetch, new RegExp(HOTPOT_REVISION));
  assert.match(hotpotFetch, /CI/);
  assert.match(bridge, new RegExp(IFBENCH_VERIFIER_SHA));
  assert.match(requirements, new RegExp(IFBENCH_VERIFIER_SHA));
  assert.match(readFileSync(`${root}/benchmarks/hotpotqa/normalize.ts`, "utf8"), new RegExp(HOTPOT_EVAL_SHA));
});

async function assertRegression<T extends PublicExample>(task: BenchmarkTask<T>): Promise<void> {
  const report = await runOfflineBenchmark(task, {
    seeds: [1],
    source: "fixtures",
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
  });
  assert.equal(report.passed, true);
  assert.equal(report.minimumImprovement, PRODUCT_MINIMUM_IMPROVEMENT);
  assert.equal(report.regression.passed, true);
  assert.equal(report.regression.harmful.finalState, "no_improvement");
  assert.equal(report.regression.harmful.finalReason, "validation_failed");
  assert.equal(report.regression.harmful.servedVersion, report.regression.harmful.baselineVersion);
  assert.equal(report.regression.rollback.finalState, "rolled_back");
  assert.equal(report.perSeed[0]?.leakedIds.length, 0);
  assert.equal(report.perSeed[0]?.oneShot.gates, "none");
  assert.notEqual(report.perSeed[0]?.oneShot.version, report.perSeed[0]?.oneShot.baselineVersion);
  assert.equal(report.perSeed[0]?.controller.state, "completed");
  assert.equal(report.arms.oneShot.gates, "none");
  assert.equal(report.arms.controller.gates, "improvement-controller");
  assert.ok(report.arms.controller.ungated);
}

async function assertHarmfulOneShot<T extends PublicExample>(task: BenchmarkTask<T>): Promise<void> {
  const loaded = task.fixtures();
  const split = buildSeededSplit({
    pool: loaded.pool,
    heldOut: loaded.heldOut,
    seed: 1,
    sizes: FIXTURE_SIZES,
  });
  const arm = await runOneShot({
    task,
    split,
    runner: mockRunner(task),
    mode: "harmful",
  });
  assert.equal(arm.gates, "none");
  assert.equal(arm.state, "applied");
  assert.notEqual(arm.version, arm.baselineVersion);
  assert.match(arm.fragment, /loopiter-mock-harm/);
  assert.deepEqual(leakedIds(arm.readIds, idsOf(split.heldOut)), []);
  const baselineRate =
    split.heldOut.filter((row) => row.example.baselinePass).length / split.heldOut.length;
  assert.equal(arm.heldOut.rate < baselineRate, true);
}

function scrubbed(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AZURE_") || key.startsWith("LOOPITER_BENCH") || key === "LOOPITER_BENCHMARK_LIVE")
      delete env[key];
  }
  return { ...env, ...extra };
}
