/**
 * Offline mock comparison: frozen baseline, ungated one-shot, and the
 * autonomous controller. The harmful-candidate check uses the product gate.
 */
import { describeAuditFloor } from "../../src/improvement-evidence.js";
import { judgeRegression, type RegressionEvidence } from "../kb-qa/checks.js";
import { bootstrapMeanInterval, wilsonInterval } from "../kb-qa/stats.js";
import {
  FULL_AUDIT_ROWS,
  PRODUCT_ALPHA,
  PRODUCT_MINIMUM_IMPROVEMENT,
  observedGainRequired,
} from "./constants.js";
import {
  leakedIds,
  mockRunner,
  runController,
  runOneShot,
  scoreHeldOut,
  type ArmRun,
  type RateDraft,
} from "./loop.js";
import { buildSeededSplit, idsOf, type PublicSplit } from "./splits.js";
import type { BenchmarkTask, PublicExample } from "./task.js";

const BOOTSTRAP_SAMPLES = 2_000;
const BOOTSTRAP_SEED = 17;

export interface IntervalView {
  mean: number;
  lower: number;
  upper: number;
  samples: number;
  seed: number;
}

export interface MetricView {
  rate: number;
  bootstrap: IntervalView;
  wilson: { successes: number; trials: number; lower: number; upper: number } | null;
}

export interface ScoreView {
  primary: MetricView;
  loosePrompt: IntervalView | null;
  instructionStrict: IntervalView | null;
  instructionLoose: IntervalView | null;
  f1: IntervalView | null;
}

export interface OfflineReport {
  schemaVersion: 1;
  harness: string;
  task: string;
  liveCalls: 0;
  provider: "mock";
  data: "fixtures" | "cache";
  seeds: number[];
  minimumImprovement: number;
  regressionMinimumImprovement: number;
  promptCapCharacters: number;
  promptVersion: string;
  auditCaveat: {
    auditRows: number;
    alpha: number;
    observedGainRequired: number;
    note: string;
  };
  splits: {
    optimization: number;
    validation: number;
    audit: number;
    production: number;
    heldOut: number;
  };
  arms: {
    baseline: { served: ScoreView; ungated: null };
    oneShot: { served: ScoreView; ungated: ScoreView; gates: "none" };
    controller: {
      served: ScoreView;
      ungated: ScoreView | null;
      gates: "improvement-controller";
    };
  };
  perSeed: {
    seed: number;
    leakedIds: string[];
    baseline: RateDraft;
    oneShot: { state: string; gates: "none"; version: string; baselineVersion: string; served: RateDraft };
    controller: {
      state: string;
      reason: string;
      version: string;
      baselineVersion: string;
      served: RateDraft;
      ungated: RateDraft | null;
      transitions: { state: string; reason: string }[];
    };
  }[];
  regression: RegressionEvidence & { passed: boolean; failures: string[] };
  passed: boolean;
}

export async function runOfflineBenchmark<T extends PublicExample>(
  task: BenchmarkTask<T>,
  options: {
    seeds: number[];
    minimumImprovement?: number;
    source?: "fixtures" | "cache";
    bootstrapSamples?: number;
    bootstrapSeed?: number;
  },
): Promise<OfflineReport> {
  const seeds = options.seeds;
  if (seeds.length < 1) throw new Error("At least one seed is required.");
  if (new Set(seeds).size !== seeds.length) throw new Error("Seeds must be unique.");
  const minimumImprovement = options.minimumImprovement ?? PRODUCT_MINIMUM_IMPROVEMENT;
  const source = options.source ?? "fixtures";
  const loaded = source === "fixtures" ? task.fixtures() : await task.loadCache();
  const sizes = source === "fixtures" ? task.fixtureSizes : task.fullSizes;
  const samples = options.bootstrapSamples ?? BOOTSTRAP_SAMPLES;
  const bootstrapSeed = options.bootstrapSeed ?? BOOTSTRAP_SEED;
  const perSeed = [];
  for (const seed of seeds) {
    const split = buildSeededSplit({ pool: loaded.pool, heldOut: loaded.heldOut, seed, sizes });
    const runner = mockRunner(task);
    const heldOutIds = idsOf(split.heldOut);
    const baseline = await scoreHeldOut(task, runner, task.baselinePrompt, split.heldOut);
    const oneShot = await runOneShot({ task, split, runner, mode: "improve" });
    const controller = await runController({
      task,
      split,
      runner,
      mode: "improve",
      observation: "honest",
      minimumImprovement,
      batchSize: Math.max(split.validation.length, split.audit.length),
      observeChunk: split.production.length,
      latencyMs: 120_000,
      modelId: "mock",
      scenario: "compare",
      tickLimit: 40,
    });
    const leaked = [
      ...leakedIds(oneShot.readIds, heldOutIds),
      ...leakedIds(controller.readIds, heldOutIds),
    ];
    if (leaked.length)
      throw new Error(`Held-out ids were exposed to the loop: ${leaked.join(", ")}`);
    perSeed.push({ seed, leakedIds: leaked, baseline, oneShot, controller, split });
  }
  const regression = await runRegression(task, perSeed[0]!.split);
  const judgment = judgeRegression(regression);
  const gain = observedGainRequired({
    auditRows: FULL_AUDIT_ROWS,
    minimumImprovement,
    alpha: PRODUCT_ALPHA,
  });
  const report: OfflineReport = {
    schemaVersion: 1,
    harness: `loopiter-offline-${task.id}`,
    task: task.id,
    liveCalls: 0,
    provider: "mock",
    data: source,
    seeds,
    minimumImprovement,
    regressionMinimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    promptCapCharacters: task.promptCap,
    promptVersion: task.promptVersion,
    auditCaveat: {
      auditRows: FULL_AUDIT_ROWS,
      alpha: PRODUCT_ALPHA,
      observedGainRequired: gain,
      note: caveat(minimumImprovement, gain),
    },
    splits: {
      optimization: sizes.optimization,
      validation: sizes.validation,
      audit: sizes.audit,
      production: sizes.production,
      heldOut: sizes.heldOut,
    },
    arms: {
      baseline: {
        served: viewOf(perSeed.map((row) => row.baseline), samples, bootstrapSeed),
        ungated: null,
      },
      oneShot: {
        served: viewOf(perSeed.map((row) => row.oneShot.heldOut), samples, bootstrapSeed),
        ungated: viewOf(perSeed.map((row) => row.oneShot.ungated ?? row.oneShot.heldOut), samples, bootstrapSeed),
        gates: "none",
      },
      controller: {
        served: viewOf(perSeed.map((row) => row.controller.heldOut), samples, bootstrapSeed),
        ungated: everyUngated(perSeed.map((row) => row.controller.ungated))
          ? viewOf(
              perSeed.map((row) => row.controller.ungated!),
              samples,
              bootstrapSeed,
            )
          : null,
        gates: "improvement-controller",
      },
    },
    perSeed: perSeed.map((row) => ({
      seed: row.seed,
      leakedIds: row.leakedIds,
      baseline: row.baseline,
      oneShot: {
        state: row.oneShot.state,
        gates: "none" as const,
        version: row.oneShot.version,
        baselineVersion: row.oneShot.baselineVersion,
        served: row.oneShot.heldOut,
      },
      controller: {
        state: row.controller.state,
        reason: row.controller.reason,
        version: row.controller.version,
        baselineVersion: row.controller.baselineVersion,
        served: row.controller.heldOut,
        ungated: row.controller.ungated,
        transitions: row.controller.transitions,
      },
    })),
    regression: { ...regression, passed: judgment.passed, failures: judgment.failures },
    passed:
      judgment.passed &&
      perSeed.every((row) => row.oneShot.gates === "none") &&
      perSeed.every((row) => row.controller.state.length > 0),
  };
  return report;
}

async function runRegression<T extends PublicExample>(
  task: BenchmarkTask<T>,
  split: PublicSplit<T>,
): Promise<RegressionEvidence> {
  const runner = mockRunner(task);
  const baseline = await scoreHeldOut(task, runner, task.baselinePrompt, split.heldOut);
  const harmful = await runController({
    task,
    split,
    runner,
    mode: "harmful",
    observation: "honest",
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    batchSize: Math.max(split.validation.length, split.audit.length),
    observeChunk: split.production.length,
    latencyMs: 120_000,
    modelId: "mock",
    scenario: "harmful",
    tickLimit: 40,
  });
  const rollback = await runController({
    task,
    split,
    runner,
    mode: "improve",
    observation: "fail",
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    batchSize: Math.max(split.validation.length, split.audit.length),
    observeChunk: split.production.length,
    latencyMs: 120_000,
    modelId: "mock",
    scenario: "rollback",
    tickLimit: 40,
  });
  if (!harmful.ungated) throw new Error("Harmful proposal was not scored.");
  return {
    tolerance: 0,
    harmful: {
      finalState: harmful.state,
      finalReason: harmful.reason,
      sawValidationFailure: harmful.transitions.some((step) => step.reason === "validation_failed"),
      baselineRate: baseline.rate,
      servedRate: harmful.heldOut.rate,
      counterfactualRate: harmful.ungated.rate,
      servedVersion: harmful.version,
      baselineVersion: harmful.baselineVersion,
    },
    rollback: {
      finalState: rollback.state,
      finalReason: rollback.reason,
      sawGuardrailFailure: rollback.transitions.some(
        (step) => step.reason === "production_guardrail_failed",
      ),
      baselineRate: baseline.rate,
      servedRate: rollback.heldOut.rate,
      servedVersion: rollback.version,
      baselineVersion: rollback.baselineVersion,
    },
  };
}

export function renderMarkdown(report: OfflineReport): string {
  const lines = [
    `# Offline ${report.task} benchmark`,
    "",
    "Mock run. Live model calls: 0. Results are internal. Do not publish them.",
    "",
    `minimumImprovement ${report.minimumImprovement}. ${report.auditCaveat.note}`,
    "",
    "| Arm | Served primary | Ungated primary |",
    "| --- | ---: | ---: |",
    `| Frozen baseline | ${fmt(report.arms.baseline.served.primary.rate)} |  |`,
    `| One-shot rewrite | ${fmt(report.arms.oneShot.served.primary.rate)} | ${fmt(report.arms.oneShot.ungated.primary.rate)} |`,
    `| Autonomous controller | ${fmt(report.arms.controller.served.primary.rate)} | ${report.arms.controller.ungated ? fmt(report.arms.controller.ungated.primary.rate) : ""} |`,
    "",
    report.regression.passed
      ? "Regression check passed. The validation gate rejected the harmful candidate."
      : `Regression check failed. ${report.regression.failures.join(" ")}`,
    "",
    `Overall: ${report.passed ? "PASS" : "FAIL"}.`,
    "",
  ];
  return lines.join("\n");
}

function caveat(minimumImprovement: number, required: number): string {
  const floor = describeAuditFloor({
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    range: [0, 1],
    alpha: PRODUCT_ALPHA,
  });
  return `The paired Hoeffding audit at ${FULL_AUDIT_ROWS} rows needs an observed gain above ${required.toFixed(3)} when minimumImprovement is ${minimumImprovement}. With the product default of ${PRODUCT_MINIMUM_IMPROVEMENT} that is about 19 percentage points, so a smaller real gain is rejected. ${floor}`;
}

export function viewOf(rates: RateDraft[], samples: number, seed: number): ScoreView {
  return {
    primary: metric(rates.map((row) => row.rate), rates.reduce((sum, row) => sum + row.successes, 0), rates.reduce((sum, row) => sum + row.trials, 0), samples, seed),
    loosePrompt: optionalInterval(rates.map((row) => row.loose), samples, seed),
    instructionStrict: optionalInterval(rates.map((row) => row.instructionStrict), samples, seed),
    instructionLoose: optionalInterval(rates.map((row) => row.instructionLoose), samples, seed),
    f1: optionalInterval(rates.map((row) => row.f1), samples, seed),
  };
}

function metric(
  values: number[],
  successes: number,
  trials: number,
  samples: number,
  seed: number,
): MetricView {
  const bootstrap = bootstrapMeanInterval(values, { samples, seed });
  const wilson = wilsonInterval(successes, trials);
  return {
    rate: bootstrap.mean,
    bootstrap: {
      mean: bootstrap.mean,
      lower: bootstrap.lower,
      upper: bootstrap.upper,
      samples: bootstrap.samples,
      seed: bootstrap.seed,
    },
    wilson: {
      successes: wilson.successes,
      trials: wilson.trials,
      lower: wilson.lower,
      upper: wilson.upper,
    },
  };
}

function optionalInterval(
  values: (number | null)[],
  samples: number,
  seed: number,
): IntervalView | null {
  if (values.some((value) => value === null)) return null;
  const bootstrap = bootstrapMeanInterval(values as number[], { samples, seed });
  return {
    mean: bootstrap.mean,
    lower: bootstrap.lower,
    upper: bootstrap.upper,
    samples: bootstrap.samples,
    seed: bootstrap.seed,
  };
}

function everyUngated(values: (RateDraft | null)[]): boolean {
  return values.every((value) => value !== null);
}

function fmt(value: number): string {
  return value.toFixed(4);
}

export type { ArmRun };
