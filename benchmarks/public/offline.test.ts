import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateChange } from "../../src/index.js";
import { loadIfbenchCache } from "../ifbench/cache.js";
import { UnsupportedInstructionError, closeVerifier, scoreWithVerifiers } from "../ifbench/score.js";
import {
  IFBENCH_TEST_REVISION,
  IFBENCH_TEST_ROWS,
  IFBENCH_TRAIN_REVISION,
  IFBENCH_VERIFIER_SHA,
} from "../ifbench/pins.js";
import { ifbenchTask } from "../ifbench/task.js";
import type { BenchmarkTask, ModelRunner, PublicExample } from "./task.js";
import { exactMatch, normalizeAnswer, tokenF1 } from "../hotpotqa/normalize.js";
import { HOTPOT_EVAL_SHA, HOTPOT_REVISION } from "../hotpotqa/pins.js";
import type { HotpotExample } from "../hotpotqa/fixtures.js";
import { hotpotTask } from "../hotpotqa/task.js";
import {
  FIXTURE_SIZES,
  FULL_AUDIT_ROWS,
  FULL_SIZES,
  MAX_SPLIT_ROWS,
  PRODUCT_MINIMUM_IMPROVEMENT,
  PROMPT_CAP,
  observedGainRequired,
} from "./constants.js";
import { estimateSelection, rowCountOverrides } from "./cli.js";
import { planTask, renderTaskEstimate } from "./estimate.js";
import { resolveLimits } from "./limits.js";
import { emptySeedLog, promptHash, readDecisionLog, replaySeed, writeDecisionLog } from "./decisions.js";
import { runOfflineBenchmark } from "./harness.js";
import { leakedIds, mockRunner, runController, runOneShot } from "./loop.js";
import { promptPolicy } from "./policy.js";
import { repoRoot } from "./paths.js";
import {
  applyRowCounts,
  assertPoolCoversSeeds,
  buildSeededSplit,
  idsOf,
  poolDatasetRow,
  splitAuditRows,
  type HeldOutRow,
  type PoolRow,
} from "./splits.js";

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
  assert.notEqual(report.perSeed[0]?.controller.reason, "invalid_policy");
  const required = observedGainRequired({
    auditRows: FULL_AUDIT_ROWS,
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
  });
  assert.ok(required > 0.19 && required < 0.2);
});

test("the built cache loader reads the source instruction list", async () => {
  const root = repoRoot(import.meta.url);
  const sourceList = join(root, "benchmarks", "ifbench", "supported-instructions.json");
  const distList = join(root, "dist", "benchmarks", "ifbench", "supported-instructions.json");
  assert.equal(existsSync(sourceList), true);
  assert.equal(existsSync(distList), false);
  const cache = join(root, "benchmarks", ".cache", "ifbench");
  const aside = `${cache}.test-aside`;
  await rm(aside, { recursive: true, force: true });
  if (existsSync(cache)) await rename(cache, aside);
  try {
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, "manifest.json"),
      `${JSON.stringify({
        testRevision: IFBENCH_TEST_REVISION,
        trainRevision: IFBENCH_TRAIN_REVISION,
        verifierRevision: "not-the-pin",
      })}\n`,
    );
    await assert.rejects(
      loadIfbenchCache(),
      new RegExp(`verifier revision does not match ${IFBENCH_VERIFIER_SHA}`),
    );
    await writeFile(
      join(cache, "manifest.json"),
      `${JSON.stringify({
        testRevision: IFBENCH_TEST_REVISION,
        trainRevision: IFBENCH_TRAIN_REVISION,
        verifierRevision: IFBENCH_VERIFIER_SHA,
      })}\n`,
    );
    const row = (id: string) =>
      JSON.stringify({
        id,
        prompt: `Prompt ${id}`,
        instructionIdList: ["keywords:existence"],
        kwargs: [{ keywords: ["quartz"] }],
      });
    await writeFile(
      join(cache, "test.jsonl"),
      `${Array.from({ length: IFBENCH_TEST_ROWS }, (_, index) => row(`held-${index}`)).join("\n")}\n`,
    );
    await writeFile(
      join(cache, "train.jsonl"),
      `${[
        row("train-kept"),
        JSON.stringify({
          id: "train-dropped",
          prompt: "Unsupported train row",
          instructionIdList: ["not:real"],
          kwargs: [{}],
        }),
      ].join("\n")}\n`,
    );
    const loaded = await loadIfbenchCache();
    assert.equal(loaded.heldOut.length, IFBENCH_TEST_ROWS);
    assert.deepEqual(
      loaded.pool.map((item) => item.id),
      ["train-kept"],
    );
    assert.deepEqual(loaded.pool[0]?.instructionIdList, ["keywords:existence"]);
  } finally {
    await rm(cache, { recursive: true, force: true });
    if (existsSync(aside)) await rename(aside, cache);
  }
});

test("an unknown IFBench instruction stops the verifier", async () => {
  await assert.rejects(
    scoreWithVerifiers([
      {
        prompt: "Say hello.",
        response: "hello",
        instructionIdList: ["not:real"],
        kwargs: [{}],
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedInstructionError);
      assert.equal(error.instructionId, "not:real");
      assert.equal(error.message.includes("hello"), false);
      return true;
    },
  );
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
  assert.equal(ifbenchTask.predict.defaultValue, 8192);
  assert.equal(hotpotTask.predict.defaultValue, 2048);
  assert.equal(ifbenchTask.predict.min, 1024);
  assert.equal(ifbenchTask.predict.max, 8192);
  assert.equal(hotpotTask.predict.max, 8192);
  assert.throws(() => resolveLimits({ LOOPITER_BENCH_PREDICT_MAX_OUTPUT_TOKENS: "256" }, ifbenchTask));
  const limits = resolveLimits({}, ifbenchTask);
  assert.equal(limits.predictMaxOutputTokens, 8192);
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
  assert.equal(ifbench.arms.controller.length, 13505);
  assert.equal(hotpot.arms.baseline.length, 1500);
  assert.equal(hotpot.arms["one-shot"].length, 1505);
  assert.equal(hotpot.arms.controller.length, 12755);
  assert.match(combined.stdout, /calls: 13505/);
  assert.match(combined.stdout, /calls: 12755/);
  assert.match(combined.stdout, /Predict max output tokens: 8192/);
  assert.match(combined.stdout, /Predict max output tokens: 2048/);
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
  const supported = JSON.parse(
    readFileSync(`${root}/benchmarks/ifbench/supported-instructions.json`, "utf8"),
  ) as { revision: string; ids: string[] };
  assert.equal(supported.revision, IFBENCH_VERIFIER_SHA);
  const listed = spawnSync(
    process.env.LOOPITER_BENCH_PYTHON ?? "python3",
    [
      "-c",
      "from ifbench import instructions_registry; import json; print(json.dumps(sorted(instructions_registry.INSTRUCTION_DICT)))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(supported.ids, JSON.parse(listed.stdout));
  const filtered = spawnSync(
    process.env.LOOPITER_BENCH_PYTHON ?? "python3",
    [
      "-c",
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("fetch", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
supported = mod.load_supported_ids()
train = [
    {"id": "keep", "instructionIdList": ["keywords:existence"]},
    {"id": "drop", "instructionIdList": ["keywords:existence", "not:real"]},
]
kept, stats = mod.keep_supported(train, "train", supported)
assert [row["id"] for row in kept] == ["keep"]
assert stats["droppedRows"] == 1
assert stats["unsupported"] == [{"id": "not:real", "rows": 1}]
try:
    mod.keep_supported([{"id": "t", "instructionIdList": ["not:real"]}], "test", supported)
except SystemExit as error:
    assert "unsupported" in str(error)
else:
    raise SystemExit("test rows must fail closed")
print("ok")
`,
      `${root}/benchmarks/ifbench/fetch.py`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(filtered.status, 0, filtered.stderr || filtered.stdout);
  assert.match(readFileSync(`${root}/benchmarks/hotpotqa/normalize.ts`, "utf8"), new RegExp(HOTPOT_EVAL_SHA));
});

test("row-count options keep the defaults and reject bad values", () => {
  assert.deepEqual(rowCountOverrides(["node", "run.js"]), {});
  assert.deepEqual(applyRowCounts(FULL_SIZES, rowCountOverrides(["--live"])), FULL_SIZES);
  assert.deepEqual(applyRowCounts(FIXTURE_SIZES, rowCountOverrides(["--fixtures"])), FIXTURE_SIZES);
  assert.equal(estimateSelection(["--estimate"], FULL_SIZES), undefined);
  const chosen = rowCountOverrides(["--validation-rows", "500", "--audit-rows", "600"]);
  assert.deepEqual(chosen, { validationRows: 500, auditRows: 600 });
  const sizes = applyRowCounts(FULL_SIZES, chosen);
  assert.equal(sizes.validation, 500);
  assert.equal(sizes.audit, 600);
  assert.equal(sizes.optimization, FULL_SIZES.optimization);
  assert.equal(sizes.production, FULL_SIZES.production);
  assert.equal(sizes.heldOut, FULL_SIZES.heldOut);
  const validationOnly = applyRowCounts(FULL_SIZES, rowCountOverrides(["--validation-rows", "40"]));
  assert.equal(validationOnly.validation, 40);
  assert.equal(validationOnly.audit, FULL_SIZES.audit);
  assert.equal(rowCountOverrides(["--validation-rows", "1"]).validationRows, 1);
  assert.equal(rowCountOverrides(["--audit-rows", "2"]).auditRows, 2);
  assert.equal(rowCountOverrides(["--audit-rows", String(MAX_SPLIT_ROWS)]).auditRows, MAX_SPLIT_ROWS);
  const selection = estimateSelection(
    ["--estimate", "--seeds", "3", "--validation-rows", "500", "--audit-rows", "500"],
    FULL_SIZES,
  );
  assert.deepEqual(selection?.seeds, [1, 2, 3]);
  assert.equal(selection?.sizes?.validation, 500);
  assert.equal(selection?.sizes?.audit, 500);
  assert.equal(selection?.sizes?.heldOut, 300);
  for (const [flag, value] of [
    ["--validation-rows", "0"],
    ["--validation-rows", "-1"],
    ["--validation-rows", "1.5"],
    ["--validation-rows", "10001"],
    ["--validation-rows", "nope"],
    ["--audit-rows", "1"],
    ["--audit-rows", "0"],
    ["--audit-rows", "10001"],
  ] as const)
    assert.throws(() => rowCountOverrides([flag, value]), new RegExp(flag));
  assert.throws(() => rowCountOverrides(["--validation-rows"]), /Missing value for --validation-rows/);
  assert.throws(() => rowCountOverrides(["--audit-rows", "--seeds"]), /Missing value for --audit-rows/);
});

test("an odd audit count gives the one-shot the extra row", () => {
  const rows = ["b", "a", "c", "d", "e"].map((id) => ({ example: { id } }));
  const [first, second] = splitAuditRows(rows);
  assert.deepEqual(
    first.map((row) => row.example.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    second.map((row) => row.example.id),
    ["d", "e"],
  );
  const odd = ["m", "a", "z"].map((id) => ({ example: { id } }));
  const [left, right] = splitAuditRows(odd);
  assert.deepEqual(
    left.map((row) => row.example.id),
    ["a", "m"],
  );
  assert.deepEqual(
    right.map((row) => row.example.id),
    ["z"],
  );
});

test("chosen row counts set the policy units, reservations, and budget", () => {
  const sizes = applyRowCounts(FULL_SIZES, { validationRows: 500, auditRows: 500 });
  const predictReservation = 3;
  const proposeReservation = 7;
  const batchSize = 1;
  const observeChunk = 2;
  const policy = promptPolicy({
    taskId: "hotpotqa",
    promptCap: PROMPT_CAP,
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    sizes,
    latencyMs: 1000,
    predictReservation,
    proposeReservation,
    batchSize,
    observeChunk,
  });
  assert.equal(policy.minimumValidationUnits, 500);
  assert.equal(policy.minimumAuditUnits, 500);
  assert.equal(policy.maximumRows, 500);
  assert.equal(policy.observation.minimumUnits, sizes.production);
  const evaluateCalls = batchSize * 2;
  const observeCalls = observeChunk;
  assert.equal(
    policy.callbackReservation.modelRequests,
    Math.max(sizes.validation, sizes.audit, evaluateCalls, observeCalls, 1) * 2 + 10,
  );
  assert.equal(
    policy.callbackReservation.tokens,
    Math.max(proposeReservation, evaluateCalls * predictReservation, observeCalls * predictReservation),
  );
  const loopCalls = 1 + sizes.validation * 2 + sizes.audit * 2 + sizes.production;
  assert.equal(policy.daily.modelRequests, loopCalls * 4);
  assert.equal(
    policy.daily.tokens,
    proposeReservation +
      (sizes.optimization +
        sizes.validation * 2 +
        sizes.audit * 2 +
        sizes.production +
        sizes.heldOut * 2) *
        predictReservation,
  );
  const phase = promptPolicy({
    taskId: "hotpotqa",
    promptCap: PROMPT_CAP,
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    sizes: { ...sizes, audit: Math.ceil(7 / 2) },
    latencyMs: 1000,
    predictReservation,
    proposeReservation,
    batchSize,
    observeChunk,
  });
  assert.equal(phase.minimumValidationUnits, sizes.validation);
  assert.equal(phase.minimumAuditUnits, 4);
  assert.equal(phase.maximumRows, Math.max(4, sizes.validation, sizes.optimization));
});

test("the estimate uses the chosen seeds and row counts", () => {
  const hotpotSizes = applyRowCounts(FULL_SIZES, { validationRows: 500, auditRows: 500 });
  const hotpot = planTask(hotpotTask, {
    label: "full",
    seeds: [1, 2, 3],
    sizes: hotpotSizes,
    limits: resolveLimits({}, hotpotTask),
    deployment: "gpt-5.4-mini",
  });
  assert.equal(hotpot.arms.baseline.length, 900);
  assert.equal(hotpot.arms["one-shot"].length, 903);
  assert.equal(hotpot.arms.controller.length, 14253);
  const ifbenchSizes = applyRowCounts(FULL_SIZES, { validationRows: 600, auditRows: 600 });
  const ifbench = planTask(ifbenchTask, {
    label: "full",
    seeds: [1, 2, 3],
    sizes: ifbenchSizes,
    limits: resolveLimits({}, ifbenchTask),
    deployment: "gpt-5.4-mini",
  });
  assert.equal(ifbench.arms.baseline.length, 900);
  assert.equal(ifbench.arms["one-shot"].length, 1353);
  assert.equal(ifbench.arms.controller.length, 17103);
  const text = renderTaskEstimate(
    hotpotTask,
    scrubbed({
      LOOPITER_BENCH_PRICE_INPUT_PER_1M: "1",
      LOOPITER_BENCH_PRICE_OUTPUT_PER_1M: "2",
    }),
    { seeds: [1, 2, 3], sizes: hotpotSizes },
  );
  assert.match(text, /seeds: 1, 2, 3/);
  assert.match(text, /validation 500, audit 500, production 150, held-out 300/);
  assert.match(text, /calls: 14253/);
  assert.match(text, /smoke/);
});

test("the pool check fails before a run when the rows do not fit", async () => {
  assert.throws(
    () =>
      assertPoolCoversSeeds({
        pool: [{ id: "only" }],
        heldOut: [{ id: "held" }],
        seeds: [1, 2],
        sizes: { optimization: 1, validation: 500, audit: 500, production: 1, heldOut: 1 },
      }),
    /validation 500, audit 500/,
  );
  assert.throws(
    () =>
      assertPoolCoversSeeds({
        pool: [{ id: "same" }, { id: "b" }, { id: "c" }, { id: "d" }],
        heldOut: [{ id: "same" }],
        seeds: [1],
        sizes: { optimization: 1, validation: 1, audit: 2, production: 1, heldOut: 1 },
      }),
    /also in the pool/,
  );
  await assert.rejects(
    () =>
      runOfflineBenchmark(hotpotTask, {
        seeds: [1, 2],
        source: "fixtures",
        sizes: { ...FIXTURE_SIZES, validation: 100, audit: 100 },
      }),
    /Pool has/,
  );
});

test("a fixtures run with non-default row counts replays", async () => {
  const sizes = { ...FIXTURE_SIZES, validation: 5, audit: 10 };
  const directory = await mkdtemp(join(tmpdir(), "row-counts-"));
  try {
    const report = await runOfflineBenchmark(hotpotTask, {
      seeds: [1],
      source: "fixtures",
      sizes,
      decisionLogPath: join(directory, "decisions.json"),
    });
    assert.deepEqual(report.splits, sizes);
    assert.equal(report.auditCaveat.auditRows, sizes.audit);
    const file = readDecisionLog(join(directory, "decisions.json"));
    const log = file.seeds[0];
    assert.ok(log);
    assert.deepEqual(log.splits, sizes);
    assert.equal(replaySeed(log).matched, true);
    const validation = log.rounds.filter((round) => round.split === "validation");
    const audit = log.rounds.filter((round) => round.split === "audit");
    assert.equal(validation[0]?.items?.length, sizes.validation);
    assert.equal(audit[0]?.items?.length, Math.ceil(sizes.audit / 2));
    const legacy = { ...log };
    delete legacy.splits;
    writeDecisionLog(join(directory, "legacy.json"), [legacy]);
    const again = readDecisionLog(join(directory, "legacy.json")).seeds[0];
    assert.equal(again?.splits, undefined);
    assert.equal(replaySeed(again!).matched, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the public CLI parses row counts and a fixtures run replays", async () => {
  const root = repoRoot(import.meta.url);
  const hotpot = fileURLToPath(new URL("../hotpotqa/run.js", import.meta.url));
  const bad = spawnSync(process.execPath, [hotpot, "--estimate", "--audit-rows", "1"], {
    cwd: root,
    env: scrubbed({}),
    encoding: "utf8",
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--audit-rows must be an integer from 2 to 10000/);
  const missing = spawnSync(process.execPath, [hotpot, "--fixtures", "--validation-rows"], {
    cwd: root,
    env: scrubbed({}),
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Missing value for --validation-rows/);
  const estimate = spawnSync(
    process.execPath,
    [hotpot, "--estimate", "--seeds", "3", "--validation-rows", "500", "--audit-rows", "500"],
    {
      cwd: root,
      env: scrubbed({
        LOOPITER_BENCH_PRICE_INPUT_PER_1M: "1",
        LOOPITER_BENCH_PRICE_OUTPUT_PER_1M: "2",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(estimate.status, 0, estimate.stderr);
  assert.match(estimate.stdout, /seeds: 1, 2, 3/);
  assert.match(estimate.stdout, /validation 500, audit 500, production 150, held-out 300/);
  assert.match(estimate.stdout, /calls: 14253/);
  const directory = await mkdtemp(join(tmpdir(), "row-cli-"));
  try {
    const out = join(directory, "report.json");
    const fixtures = spawnSync(
      process.execPath,
      [hotpot, "--fixtures", "--seeds", "1", "--validation-rows", "5", "--audit-rows", "10", "--out", out],
      { cwd: root, env: scrubbed({}), encoding: "utf8" },
    );
    assert.equal(fixtures.status, 0, fixtures.stderr);
    const report = JSON.parse(readFileSync(out, "utf8")) as { splits: { validation: number; audit: number; heldOut: number } };
    assert.equal(report.splits.validation, 5);
    assert.equal(report.splits.audit, 10);
    assert.equal(report.splits.heldOut, FIXTURE_SIZES.heldOut);
    const replay = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./replay.js", import.meta.url)), join(directory, "report.decisions.json")],
      { cwd: root, env: scrubbed({}), encoding: "utf8" },
    );
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /matched the logged decisions/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rolled-back one-shot gate keeps the accepted follow-up", async () => {
  const loaded = hotpotTask.fixtures();
  const split = buildSeededSplit({
    pool: loaded.pool,
    heldOut: loaded.heldOut,
    seed: 1,
    sizes: FIXTURE_SIZES,
  });
  const oneShot = `${hotpotTask.baselinePrompt}\n[[one-shot-gate]]`;
  const follow = `${hotpotTask.baselinePrompt}\n[[follow-up]]`;
  const runner: ModelRunner<HotpotExample> = {
    async answer(prompt, row, context, site) {
      if (context) await context.meter(64, async () => ({ value: true, tokens: 32 }));
      const pass = row.answer;
      const fail = "unknown";
      if (prompt === oneShot && site?.split === "production") return { text: fail, latencyMs: 1 };
      if (prompt === oneShot || prompt === follow) return { text: pass, latencyMs: 1 };
      return { text: row.baselinePass ? pass : fail, latencyMs: 1 };
    },
    async propose(_request, context) {
      if (context) await context.meter(64, async () => ({ value: true, tokens: 32 }));
      return follow;
    },
  };
  const decisionLog = emptySeedLog(split.seed, hotpotTask.baselinePrompt);
  const arm = await runController({
    task: hotpotTask,
    split,
    runner,
    mode: "improve",
    observation: "honest",
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    oneShotFragment: oneShot,
    decisionLog,
    batchSize: Math.max(split.validation.length, split.audit.length),
    observeChunk: split.production.length,
    latencyMs: 120_000,
    modelId: "mock",
    scenario: "rollback-then-accept",
    tickLimit: 40,
  });
  assert.equal(arm.fragment, follow);
  assert.equal(arm.decisions?.served.promptHash, promptHash(follow));
  assert.equal(arm.decisions?.observation, "rolled_back");
  assert.ok((arm.decisions?.rolledBackIds?.length ?? 0) > 0);
  assert.notEqual(arm.decisions?.served.id, arm.decisions?.baseline.id);
  assert.equal(replaySeed(arm.decisions!).matched, true);
});

async function assertRegression<T extends PublicExample>(task: BenchmarkTask<T>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gate-log-"));
  const report = await runOfflineBenchmark(task, {
    seeds: [1],
    source: "fixtures",
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    decisionLogPath: join(directory, "decisions.json"),
  });
  try {
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
  assert.equal(report.perSeed[0]!.controller.state, "completed");
  const log = readDecisionLog(join(directory, "decisions.json")).seeds[0];
  assert.ok(log);
  assert.equal(log.complete, true);
  assert.equal(replaySeed(log).matched, true);
  const promoted = log.rounds.some((round) => round.split === "audit" && round.decision.accept);
  assert.equal(log.served.id === log.baseline.id, !promoted || log.observation === "rolled_back");
  assert.equal(report.arms.oneShot.gates, "none");
  assert.equal(report.arms.controller.gates, "improvement-controller");
  assert.ok(report.arms.controller.ungated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
