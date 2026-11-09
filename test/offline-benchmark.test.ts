import test from "node:test";
import assert from "node:assert/strict";
import { judgeBudget, judgeRegression } from "../benchmarks/kb-qa/checks.js";
import { runOfflineBenchmark } from "../benchmarks/kb-qa/harness.js";
import {
  costMicroUsd,
  defaultPriceTable,
  formatUsd,
  quote,
  SpendLedger,
} from "../benchmarks/kb-qa/money.js";
import {
  bootstrapMeanInterval,
  wilsonInterval,
} from "../benchmarks/kb-qa/stats.js";
import {
  answer,
  baselineFragment,
  buildSplit,
  harmfulFragment,
  improveFragment,
  mockReliability,
  questionText,
  retrieve,
  successCount,
} from "../benchmarks/kb-qa/task.js";

test("Wilson bounds stay inside the unit interval and match the zero-success case", () => {
  const none = wilsonInterval(0, 10);
  const all = wilsonInterval(10, 10);
  const half = wilsonInterval(5, 10);
  assert.equal(none.lower, 0);
  assert.equal(all.upper, 1);
  assert.ok(none.upper > 0 && none.upper < 0.5);
  assert.ok(Math.abs(none.upper - 0.277532) < 1e-4);
  assert.ok(half.lower < 0.5 && half.upper > 0.5);
  assert.ok(Math.abs(half.lower + wilsonInterval(5, 10).upper - 1) < 1e-12);
  const complement = wilsonInterval(3, 10);
  const flipped = wilsonInterval(7, 10);
  assert.ok(Math.abs(complement.lower + flipped.upper - 1) < 1e-12);
  assert.ok(Math.abs(complement.upper + flipped.lower - 1) < 1e-12);
  assert.throws(() => wilsonInterval(1, 0));
  assert.throws(() => wilsonInterval(2, 1));
});

test("seed bootstrap is reproducible and collapses when every seed matches", () => {
  const flat = bootstrapMeanInterval([0.4, 0.4, 0.4, 0.4, 0.4], {
    samples: 200,
    seed: 17,
  });
  assert.equal(flat.mean, 0.4);
  assert.equal(flat.lower, 0.4);
  assert.equal(flat.upper, 0.4);
  const once = bootstrapMeanInterval([0, 1, 0.5, 0.25, 0.75], {
    samples: 400,
    seed: 99,
  });
  const twice = bootstrapMeanInterval([0, 1, 0.5, 0.25, 0.75], {
    samples: 400,
    seed: 99,
  });
  assert.deepEqual(once, twice);
  assert.ok(once.lower < once.mean && once.mean < once.upper);
  assert.notDeepEqual(
    once,
    bootstrapMeanInterval([0, 1, 0.5, 0.25, 0.75], {
      samples: 400,
      seed: 100,
    }),
  );
});

test("price table and spend caps use integer micro-USD", () => {
  assert.equal(
    costMicroUsd(
      { input: 80, output: 12 },
      defaultPriceTable.models["gpt-5.4-mini"]!,
    ),
    128,
  );
  assert.equal(quote("propose", defaultPriceTable).microUsd, 280);
  assert.equal(quote("predict", defaultPriceTable).microUsd, 128);
  assert.equal(formatUsd(128), "0.000128");
  assert.equal(formatUsd(1_000_000), "1.000000");
  const ledger = new SpendLedger({ perRunMicroUsd: 200, totalMicroUsd: 350 });
  assert.equal(ledger.tryCharge(100, 15), true);
  assert.equal(ledger.tryCharge(100, 15), true);
  assert.equal(ledger.tryCharge(50, 15), false);
  assert.equal(ledger.stopReason, "per_run_cap");
  assert.equal(ledger.runMicroUsd, 200);
  assert.equal(ledger.refusedCalls, 1);
  ledger.beginRun();
  assert.equal(ledger.refusedCalls, 0);
  assert.equal(ledger.tryCharge(100, 15), true);
  assert.equal(ledger.tryCharge(100, 15), false);
  assert.equal(ledger.stopReason, "total_cap");
  assert.equal(ledger.runMicroUsd, 100);
  assert.equal(ledger.totalMicroUsd, 300);
  const both = new SpendLedger({ perRunMicroUsd: 50, totalMicroUsd: 50 });
  assert.equal(both.tryCharge(100, 1), false);
  assert.equal(both.stopReason, "per_run_cap");
  assert.equal(both.totalMicroUsd, 0);
});

test("held-out items stay unseen, and retrieval is frozen around harder rows", () => {
  const split = buildSplit(7);
  const partitions = [
    split.optimization,
    split.validation,
    split.audit,
    split.test,
  ];
  const ids = partitions.flat().map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  const testIds = new Set(split.test.map((row) => row.id));
  for (const row of [
    ...split.optimization,
    ...split.validation,
    ...split.audit,
  ])
    assert.equal(testIds.has(row.id), false);
  for (const rows of partitions) {
    const kinds = new Set(rows.map((row) => retrieve(questionText(row)).kind));
    for (const kind of [
      "single",
      "near-miss",
      "multi-hop",
      "miss",
      "out-of-scope",
    ] as const)
      assert.equal(kinds.has(kind), true, kind);
  }
  const times = (rows: { occurredAt: string }[]) =>
    rows.map((row) => Date.parse(row.occurredAt));
  assert.ok(
    Math.max(...times(split.optimization)) <
      Math.min(...times(split.validation)),
  );
  assert.ok(
    Math.max(...times(split.validation)) < Math.min(...times(split.audit)),
  );
  assert.ok(Math.max(...times(split.audit)) < Math.min(...times(split.test)));
  const near = split.test.find(
    (row) => retrieve(questionText(row)).kind === "near-miss",
  );
  assert.ok(near);
  const nearHit = retrieve(questionText(near));
  assert.ok(nearHit.passages.length >= 2);
  assert.equal(retrieve(questionText(near)).passages.join(), nearHit.passages.join());
  const missed = split.test.filter(
    (row) => retrieve(questionText(row)).mode !== "hit",
  );
  assert.ok(missed.length / split.test.length >= 0.2);
  const baseline = baselineFragment();
  const improved = improveFragment(
    baseline,
    split.optimization.map((row) => ({
      question: questionText(row),
      label: String(row.label),
    })),
  );
  const heldOut = split.test.map((row) => ({
    question: questionText(row),
    label: String(row.label),
  }));
  const base = successCount(baseline, heldOut, 7);
  const next = successCount(improved, heldOut, 7);
  const harmful = successCount(harmfulFragment(), heldOut, 7);
  assert.ok(next.rate > base.rate);
  assert.ok(next.rate < 1);
  assert.ok(harmful.rate < base.rate);
  for (const row of missed) {
    const question = questionText(row);
    assert.notEqual(answer(baseline, question, 7), row.label);
    assert.notEqual(answer(improved, question, 7), row.label);
  }
  const again = successCount(improved, heldOut, 7);
  assert.equal(again.successes, next.successes);
  assert.notEqual(mockReliability(1), mockReliability(2));
  const seedRates = [1, 2, 3, 4, 5].map(
    (seed) => successCount(improved, heldOut, seed).rate,
  );
  assert.ok(new Set(seedRates).size > 1);
});

test("regression and budget judgments fail closed", () => {
  const good = judgeRegression({
    tolerance: 0,
    harmful: {
      finalState: "no_improvement",
      finalReason: "validation_failed",
      sawValidationFailure: true,
      baselineRate: 0.4,
      servedRate: 0.4,
      counterfactualRate: 0,
      servedVersion: "base",
      baselineVersion: "base",
    },
    rollback: {
      finalState: "rolled_back",
      finalReason: "previous_version_restored",
      sawGuardrailFailure: true,
      baselineRate: 0.4,
      servedRate: 0.4,
      servedVersion: "base",
      baselineVersion: "base",
    },
  });
  assert.equal(good.passed, true);
  const dropped = judgeRegression({
    tolerance: 0,
    harmful: {
      finalState: "no_improvement",
      finalReason: "validation_failed",
      sawValidationFailure: true,
      baselineRate: 0.4,
      servedRate: 0.2,
      counterfactualRate: 0,
      servedVersion: "base",
      baselineVersion: "base",
    },
    rollback: {
      finalState: "rolled_back",
      finalReason: "previous_version_restored",
      sawGuardrailFailure: true,
      baselineRate: 0.4,
      servedRate: 0.4,
      servedVersion: "base",
      baselineVersion: "base",
    },
  });
  assert.equal(dropped.passed, false);
  const budget = judgeBudget({
    perRunCapMicroUsd: 100,
    totalCapMicroUsd: 150,
    totalMicroUsd: 150,
    runs: [
      {
        stopReason: "per_run_cap",
        finalState: "failed",
        finalReason: "spend_cap",
        microUsd: 100,
        calls: 2,
        refusedCalls: 1,
      },
      {
        stopReason: "total_cap",
        finalState: "failed",
        finalReason: "spend_cap",
        microUsd: 50,
        calls: 1,
        refusedCalls: 1,
      },
    ],
  });
  assert.equal(budget.passed, true);
  const over = judgeBudget({
    perRunCapMicroUsd: 100,
    totalCapMicroUsd: 150,
    totalMicroUsd: 151,
    runs: [
      {
        stopReason: "per_run_cap",
        finalState: "failed",
        finalReason: "spend_cap",
        microUsd: 100,
        calls: 2,
        refusedCalls: 1,
      },
      {
        stopReason: "total_cap",
        finalState: "completed",
        finalReason: "spend_cap",
        microUsd: 51,
        calls: 1,
        refusedCalls: 0,
      },
    ],
  });
  assert.equal(over.passed, false);
  assert.ok(over.failures.length >= 2);
});

test("mocked autonomous loop beats the frozen baseline without live calls", async () => {
  const options = { seeds: [1, 2, 3, 4, 5], bootstrapSamples: 400 };
  const report = await runOfflineBenchmark(options);
  const again = await runOfflineBenchmark(options);
  assert.equal(report.liveCalls, 0);
  assert.equal(report.provider, "mock");
  assert.equal(report.passed, true);
  assert.ok(report.arms.candidate.heldOutSuccessRate < 1);
  assert.ok(
    report.arms.candidate.heldOutSuccessRate >
      report.arms.baseline.heldOutSuccessRate,
  );
  assert.ok(
    report.arms.candidate.bootstrap.lower < report.arms.candidate.bootstrap.upper,
  );
  assert.ok(
    report.arms.baseline.bootstrap.lower < report.arms.baseline.bootstrap.upper,
  );
  const candidateRates = report.perSeed.map((row) => row.candidate.heldOut.rate);
  const baselineRates = report.perSeed.map((row) => row.baseline.heldOut.rate);
  assert.ok(new Set(candidateRates).size > 1);
  assert.ok(new Set(baselineRates).size > 1);
  assert.deepEqual(
    again.perSeed.map((row) => row.candidate.heldOut),
    report.perSeed.map((row) => row.candidate.heldOut),
  );
  assert.deepEqual(
    again.perSeed.map((row) => row.baseline.heldOut),
    report.perSeed.map((row) => row.baseline.heldOut),
  );
  for (const row of report.perSeed) {
    assert.equal(row.candidate.state, "completed");
    assert.ok(row.candidate.heldOut.rate < 1);
    assert.notEqual(
      row.candidate.servedArtifactVersion,
      row.candidate.baselineArtifactVersion,
    );
  }
  assert.equal(report.regression.passed, true);
  assert.equal(report.regression.harmful.finalReason, "validation_failed");
  assert.equal(report.regression.rollback.finalState, "rolled_back");
  assert.equal(report.budget.passed, true);
  assert.equal(report.budget.runs[0]?.stopReason, "per_run_cap");
  assert.equal(report.budget.runs[1]?.stopReason, "total_cap");
  assert.ok(report.budget.totalMicroUsd <= report.budget.totalCapMicroUsd);
  assert.ok(
    report.comparisonBudget.totalMicroUsd <= report.comparisonBudget.capMicroUsd,
  );
  assert.match(report.interval.note, /Wilson/);
  assert.match(report.interval.note, /bootstrap/i);
});
