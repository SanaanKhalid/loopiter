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
  FACTS,
  answer,
  baselineFragment,
  buildSplit,
  harmfulFragment,
  improveFragment,
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

test("held-out items stay out of train and dev, and retrieval ignores the artifact", () => {
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
  for (const fact of FACTS)
    for (const rows of partitions)
      assert.equal(
        rows.filter((row) => questionText(row).includes(fact.keyword)).length >
          0,
        true,
      );
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
  const baseline = baselineFragment();
  const improved = improveFragment(
    baseline,
    split.optimization.map((row) => ({
      question: questionText(row),
      label: String(row.label),
    })),
  );
  const stale = split.test.find((row) =>
    questionText(row).includes("expense"),
  );
  assert.ok(stale);
  const staleQuestion = questionText(stale);
  assert.equal(retrieve(staleQuestion), "expense");
  assert.notEqual(answer(baseline, staleQuestion), answer(improved, staleQuestion));
  const heldOut = split.test.map((row) => ({
    question: questionText(row),
    label: String(row.label),
  }));
  assert.equal(successCount(baseline, heldOut).rate, 0.4);
  assert.equal(successCount(improved, heldOut).rate, 1);
  assert.equal(successCount(harmfulFragment(), heldOut).rate, 0);
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
  const report = await runOfflineBenchmark({
    seeds: [1],
    bootstrapSamples: 200,
  });
  assert.equal(report.liveCalls, 0);
  assert.equal(report.provider, "mock");
  assert.equal(report.passed, true);
  assert.equal(report.arms.baseline.heldOutSuccessRate, 0.4);
  assert.equal(report.arms.candidate.heldOutSuccessRate, 1);
  assert.equal(report.perSeed[0]?.candidate.state, "completed");
  assert.notEqual(
    report.perSeed[0]?.candidate.servedArtifactVersion,
    report.perSeed[0]?.candidate.baselineArtifactVersion,
  );
  assert.equal(report.regression.harmful.finalReason, "validation_failed");
  assert.equal(report.regression.rollback.finalState, "rolled_back");
  assert.equal(report.budget.runs[0]?.stopReason, "per_run_cap");
  assert.equal(report.budget.runs[1]?.stopReason, "total_cap");
  assert.ok(report.budget.totalMicroUsd <= report.budget.totalCapMicroUsd);
  assert.ok(
    report.comparisonBudget.totalMicroUsd <= report.comparisonBudget.capMicroUsd,
  );
  assert.match(report.interval.note, /Wilson/);
  assert.match(report.interval.note, /bootstrap/i);
});
