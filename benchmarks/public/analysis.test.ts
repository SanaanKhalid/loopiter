import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { lockEvalSet, readEvalLock, verifyEvalLock } from "../../src/eval-lock.js";
import { mulberry32 } from "../kb-qa/stats.js";
import { selectHotpotHeldOut } from "../hotpotqa/cache.js";
import { HOTPOT_HELDOUT_ROWS, HOTPOT_HELDOUT_SEED } from "../hotpotqa/pins.js";
import { HOTPOT_STRONG_PROMPT } from "../hotpotqa/prompt.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { IFBENCH_STRONG_PROMPT } from "../ifbench/prompt.js";
import { ifbenchTask } from "../ifbench/task.js";
import { codePoints, FIXTURE_SIZES, FULL_SIZES, PROMPT_CAP } from "./constants.js";
import { guardEvalSuite } from "./eval-lock.js";
import { repoRoot } from "./paths.js";
import { runOfflineBenchmark } from "./harness.js";
import {
  ANALYSIS_ALPHA,
  ANALYSIS_PLAN_PATH,
  MCNEMAR_METHOD,
  NON_INFERIORITY_MARGIN,
  PAIRED_BOOTSTRAP_SAMPLES,
  PROMPT_SENSITIVITY_DEFINITION,
  addArmFailure,
  analyzeSeeds,
  emptyArmFailures,
  exactMcNemar,
  failureKindForError,
  failureKindForReason,
  headlineVerdict,
  pairedBootstrapInterval,
  poolQuestionPairs,
  promptSensitivity,
  type SeedQuestions,
} from "./analysis.js";
import type { QuestionResult } from "./loop.js";
import { buildSeededSplit } from "./splits.js";

const root = repoRoot(import.meta.url);

test("exact McNemar matches the two-sided binomial on small tables", () => {
  assert.equal(exactMcNemar(0, 0).pValue, 1);
  assert.equal(exactMcNemar(0, 0).discordant, 0);
  assert.equal(exactMcNemar(5, 0).pValue, 2 / 32);
  assert.equal(exactMcNemar(0, 6).pValue, 2 / 64);
  assert.equal(exactMcNemar(7, 1).pValue, 18 / 256);
  assert.equal(exactMcNemar(1, 1).pValue, 1);
  assert.equal(exactMcNemar(8, 8).discordant, 16);
  const large = exactMcNemar(40, 10);
  assert.equal(large.discordant, 50);
  assert.ok(large.pValue < ANALYSIS_ALPHA);
  assert.equal(MCNEMAR_METHOD, "exact-binomial");
});

test("paired bootstrap interval matches an independent resample of a small fixture", () => {
  const differences = [1, 1, -1, 0];
  const interval = pairedBootstrapInterval(differences, { samples: 100, seed: 17, confidence: 0.95 });
  assert.equal(interval.mean, 0.25);
  assert.equal(interval.unit, "question");
  assert.equal(interval.method, "paired-bootstrap-percentile");
  assert.equal(interval.samples, 100);
  assert.equal(interval.seed, 17);
  assert.deepEqual(interval, referenceInterval(differences, 100, 17, 0.95));
  const flat = pairedBootstrapInterval([1, 1, 1], { samples: 100, seed: 3 });
  assert.equal(flat.lower, 1);
  assert.equal(flat.upper, 1);
  assert.deepEqual(
    pairedBootstrapInterval(differences, { samples: 100, seed: 17 }),
    pairedBootstrapInterval(differences, { samples: 100, seed: 17 }),
  );
});

test("the headline rule applies the pre-registered order", () => {
  assert.equal(
    headlineVerdict({ lower: 0.02, upper: 0.08, mean: 0.05, pValue: 0.01 }).verdict,
    "improvement",
  );
  assert.equal(
    headlineVerdict({ lower: -0.08, upper: -0.02, mean: -0.04, pValue: 0.01 }).verdict,
    "regression",
  );
  const safe = headlineVerdict({ lower: -0.005, upper: 0.02, mean: 0.004, pValue: 0.4 });
  assert.equal(safe.verdict, "safe_never_regresses");
  assert.match(safe.statement, /Safe, never regresses/);
  assert.match(safe.statement, /non-inferiority margin of -0.010000/);
  assert.equal(
    headlineVerdict({ lower: 0.02, upper: 0.08, mean: 0.05, pValue: 0.2 }).verdict,
    "safe_never_regresses",
  );
  assert.equal(
    headlineVerdict({ lower: -0.05, upper: 0.04, mean: 0, pValue: 0.8 }).verdict,
    "no_difference",
  );
  assert.equal(
    headlineVerdict({ lower: -1, upper: -1, mean: -1, pValue: 1 }).verdict,
    "no_difference",
  );
});

test("pooled pairs, prompt sensitivity, and failure buckets use the plan", () => {
  const questions = (flags: boolean[], failed: boolean[] = []): QuestionResult[] =>
    flags.map((correct, index) => ({ id: `q${index}`, correct, failed: failed[index] === true }));
  const seeds: SeedQuestions[] = [
    {
      seed: 2,
      baseline: questions([false, true]),
      strongPrompt: questions([true, true]),
      oneShot: questions([false, false]),
      controllerServed: questions([true, true]),
      controllerUngated: null,
    },
    {
      seed: 1,
      baseline: questions([false]),
      strongPrompt: questions([false]),
      oneShot: questions([true]),
      controllerServed: questions([true], [true]),
      controllerUngated: null,
    },
  ];
  const pairs = poolQuestionPairs(
    seeds.map((seed) => ({
      seed: seed.seed,
      reference: seed.baseline,
      treatment: seed.controllerServed,
    })),
  );
  assert.deepEqual(
    pairs.map((pair) => [pair.seed, pair.id, pair.treatment - pair.reference]),
    [
      [1, "q0", 1],
      [2, "q0", 1],
      [2, "q1", 0],
    ],
  );
  const won = Array.from({ length: 20 }, (_, index) => index);
  const analysis = analyzeSeeds(
    [
      {
        seed: 1,
        baseline: won.map((index) => ({ id: `q${index}`, correct: false, failed: false })),
        strongPrompt: won.map((index) => ({ id: `q${index}`, correct: false, failed: false })),
        oneShot: won.map((index) => ({ id: `q${index}`, correct: false, failed: false })),
        controllerServed: won.map((index) => ({ id: `q${index}`, correct: true, failed: false })),
        controllerUngated: null,
      },
    ],
    { samples: 200, seed: 17 },
  );
  assert.equal(analysis.analysisPlan, ANALYSIS_PLAN_PATH);
  assert.equal(analysis.headline.name, "controller-served-vs-baseline");
  assert.equal(analysis.headline.primary, true);
  assert.equal(analysis.headline.verdict, "improvement");
  assert.equal(analysis.headline.mcnemar?.method, "exact-binomial");
  assert.equal(analysis.headline.pairedBootstrap?.unit, "question");
  assert.equal(analysis.comparisons.length, 4);
  const sensitivity = promptSensitivity(seeds);
  assert.equal(sensitivity.definition, PROMPT_SENSITIVITY_DEFINITION);
  assert.ok(sensitivity.score > 0);
  assert.ok(sensitivity.score <= 1);
  assert.deepEqual(
    sensitivity.arms.map((arm) => arm.name),
    ["baseline", "strong-prompt", "one-shot", "controller-served"],
  );
  const single = analyzeSeeds([
    {
      seed: 1,
      baseline: questions([true]),
      strongPrompt: questions([true]),
      oneShot: questions([true]),
      controllerServed: questions([false]),
      controllerUngated: null,
    },
  ]);
  assert.equal(single.headline.verdict, "no_difference");
  const tied = analyzeSeeds([
    {
      seed: 1,
      baseline: questions([true, false, true, false]),
      strongPrompt: questions([true, false, true, false]),
      oneShot: questions([true, false, true, false]),
      controllerServed: questions([true, false, true, false]),
      controllerUngated: null,
    },
  ]);
  assert.equal(tied.headline.verdict, "safe_never_regresses");
  assert.equal(tied.promptSensitivity.score, 0);

  assert.equal(failureKindForReason("refusal"), "refusal");
  assert.equal(failureKindForReason("empty_output"), "parse");
  assert.equal(failureKindForReason("invalid_output"), "parse");
  assert.equal(failureKindForReason("content_filter"), "refusal");
  assert.equal(failureKindForReason("incomplete:max_output_tokens"), null);
  assert.equal(failureKindForError(new Error("Request timed out after 1000 ms.")), "timeout");
  assert.equal(failureKindForError(new Error("provider HTTP 500")), "http5xx");
  assert.equal(failureKindForError(new Error("HTTP 503")), "http5xx");
  assert.equal(failureKindForError(new Error("ECONNRESET")), "network");
  const counts = emptyArmFailures();
  addArmFailure(counts, "baseline", "timeout");
  addArmFailure(counts, "controller", "http5xx");
  addArmFailure(counts, "one-shot", "refusal");
  addArmFailure(counts, "strong-prompt", "parse");
  assert.deepEqual(counts.baseline, { network: 0, timeout: 1, http5xx: 0, refusal: 0, parse: 0 });
  assert.equal(counts.controller.http5xx, 1);
  assert.equal(counts["one-shot"].refusal, 1);
  assert.equal(counts["strong-prompt"].parse, 1);
});

test("the offline report serializes per-question results and the headline", async () => {
  const report = await runOfflineBenchmark(hotpotTask, { seeds: [1], bootstrapSamples: 100 });
  const json = JSON.parse(JSON.stringify(report)) as typeof report;
  const baseline = json.perSeed[0]?.baseline.items ?? [];
  const strong = json.perSeed[0]?.strongPrompt.items ?? [];
  assert.equal(baseline.length, FIXTURE_SIZES.heldOut);
  assert.equal(strong.length, baseline.length);
  assert.deepEqual(
    strong.map((item) => item.id),
    baseline.map((item) => item.id),
  );
  for (const item of baseline) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.correct, "boolean");
    assert.equal(typeof item.failed, "boolean");
  }
  assert.equal(json.analysisPlan, ANALYSIS_PLAN_PATH);
  assert.equal(json.headline.name, "controller-served-vs-baseline");
  assert.equal(json.headline.pairedBootstrap?.samples, PAIRED_BOOTSTRAP_SAMPLES);
  assert.equal(json.headline.pairedBootstrap?.unit, "question");
  assert.equal(json.headline.mcnemar?.method, "exact-binomial");
  assert.equal(json.arms.baseline.served.primary.bootstrap.unit, "seed");
  assert.equal(json.arms.strongPrompt.gates, "none");
  assert.equal(json.arms.strongPrompt.served.primary.bootstrap.unit, "seed");
  assert.equal(json.promptSensitivity.definition, PROMPT_SENSITIVITY_DEFINITION);
  assert.equal(json.armFailures.baseline.network, 0);
  assert.equal(json.strongPromptVersion, hotpotTask.strongPromptVersion);
  const plan = await readFile(join(root, ANALYSIS_PLAN_PATH), "utf8");
  assert.ok(plan.includes(PROMPT_SENSITIVITY_DEFINITION));
  assert.match(plan, /0\.05/);
  assert.match(plan, /0\.01/);
  assert.match(plan, /exact binomial/i);
  assert.match(plan, /paired bootstrap/i);
  assert.match(plan, /Safe, never regresses/);
  assert.match(plan, /non-inferiority/);
  assert.match(plan, /normalized exact match/i);
  assert.match(plan, /strict prompt-level accuracy/i);
  assert.equal(ANALYSIS_ALPHA, 0.05);
  assert.equal(NON_INFERIORITY_MARGIN, 0.01);
});

test("the strong prompts are wired and stay inside the cap", () => {
  assert.notEqual(hotpotTask.strongPrompt, hotpotTask.baselinePrompt);
  assert.notEqual(ifbenchTask.strongPrompt, ifbenchTask.baselinePrompt);
  assert.equal(hotpotTask.strongPrompt, HOTPOT_STRONG_PROMPT);
  assert.equal(ifbenchTask.strongPrompt, IFBENCH_STRONG_PROMPT);
  assert.ok(codePoints(hotpotTask.strongPrompt) > 200);
  assert.ok(codePoints(ifbenchTask.strongPrompt) > 200);
  assert.ok(codePoints(hotpotTask.strongPrompt) <= PROMPT_CAP);
  assert.ok(codePoints(ifbenchTask.strongPrompt) <= PROMPT_CAP);
  assert.equal(hotpotTask.fullSizes.heldOut, HOTPOT_HELDOUT_ROWS);
  assert.equal(ifbenchTask.fullSizes.heldOut, FULL_SIZES.heldOut);
});

test("the HotpotQA held-out sample is 1000 rows and its eval lock verifies", async () => {
  assert.equal(HOTPOT_HELDOUT_ROWS, 1000);
  assert.equal(HOTPOT_HELDOUT_SEED, 1402);
  const train = Array.from({ length: 800 }, (_, index) => ({ id: `train-${index}` }));
  const validation = Array.from({ length: 1200 }, (_, index) => ({
    id: `val-${index}`,
    answer: `a${index}`,
  }));
  const trainIds = new Set(train.map((row) => row.id));
  const held = selectHotpotHeldOut(validation, { trainIds });
  assert.equal(held.length, 1000);
  assert.deepEqual(
    selectHotpotHeldOut(validation).map((row) => row.id),
    held.map((row) => row.id),
  );
  assert.deepEqual(
    selectHotpotHeldOut(validation, { rows: 300 }).map((row) => row.id),
    held.slice(0, 300).map((row) => row.id),
  );
  for (const row of held) assert.equal(trainIds.has(row.id), false);
  const split = buildSeededSplit({
    pool: train,
    heldOut: held,
    seed: 1,
    sizes: { ...FULL_SIZES, heldOut: 1000 },
  });
  const poolIds = new Set(
    [...split.optimization, ...split.validation, ...split.audit, ...split.production].map(
      (row) => row.example.id,
    ),
  );
  assert.equal(split.heldOut.length, 1000);
  for (const row of split.heldOut) assert.equal(poolIds.has(row.example.id), false);
  const suite = {
    items: held.map((row) => ({ id: row.id, input: { id: row.id }, expected: row.answer })),
  };
  const lock = lockEvalSet(suite);
  assert.equal(lock.itemCount, 1000);
  assert.equal(lock.items.length, 1000);
  assert.equal(verifyEvalLock(suite, lock).ok, true);
  const changed = {
    items: suite.items.map((item, index) => (index === 0 ? { ...item, expected: "other" } : item)),
  };
  const drift = verifyEvalLock(changed, lock);
  assert.equal(drift.ok, false);
  assert.equal(drift.changed, 1);
  const directory = await mkdtemp(join(tmpdir(), "hotpot-lock-"));
  try {
    const path = join(directory, "pinned-eval.lock.json");
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
    guardEvalSuite(suite, path);
    assert.throws(() => guardEvalSuite(changed, path), /drift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const pinned = readEvalLock(
    JSON.parse(await readFile(join(root, "benchmarks/hotpotqa/pinned-eval.lock.json"), "utf8")),
  );
  assert.equal(pinned.itemCount, 1000);
  assert.equal(pinned.scheme, 1);
  assert.equal(new Set(pinned.items.map((item) => item.id)).size, 1000);
});

function referenceInterval(
  differences: readonly number[],
  samples: number,
  seed: number,
  confidence: number,
) {
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1)
      sum += differences[Math.floor(rng() * differences.length)]!;
    means.push(sum / differences.length);
  }
  means.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  const at = (p: number) => {
    const index = (means.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return means[low]!;
    const weight = index - low;
    return means[low]! * (1 - weight) + means[high]! * weight;
  };
  return {
    mean,
    lower: at(tail),
    upper: at(1 - tail),
    confidence,
    samples,
    seed,
    method: "paired-bootstrap-percentile" as const,
    unit: "question" as const,
  };
}
