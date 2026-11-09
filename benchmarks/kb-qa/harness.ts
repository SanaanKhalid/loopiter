/**
 * Offline frozen-baseline vs autonomous-candidate harness.
 * Model calls are seeded mocks. Nothing in this module opens a network connection.
 */
import {
  FeedbackLoop,
  ImprovementController,
  InMemoryStore,
  LoopiterError,
  type CallbackContext,
  type DatasetRow,
  type DatasetSnapshot,
  type DeploymentReceipt,
  type DeploymentRequest,
  type ImprovementWorkflow,
  type JsonValue,
  type TickResult,
} from "../../src/index.js";
import { hash } from "../../src/utils.js";
import {
  promptWorkflow,
  type ArtifactRegistry,
} from "../../examples/autonomous/workflows.js";
import {
  judgeBudget,
  judgeRegression,
  type BudgetEvidence,
  type RegressionEvidence,
} from "./checks.js";
import {
  DEFAULT_MODEL,
  SpendLedger,
  defaultPriceTable,
  formatUsd,
  quote,
  usdToMicro,
  type PriceTable,
} from "./money.js";
import { bootstrapMeanInterval, wilsonInterval } from "./stats.js";
import {
  ACCURACY_FLOOR,
  OBSERVATION_ERROR_CEILING,
  SPLIT_COUNTS,
  answer,
  baselineFragment,
  buildSplit,
  harmfulFragment,
  improveFragment,
  labels,
  questionText,
  successCount,
  type TaskSplit,
} from "./task.js";

const TERMINAL = new Set([
  "completed",
  "no_improvement",
  "rolled_back",
  "waiting_for_evidence",
  "failed",
  "paused",
  "reconciliation_required",
]);

const CLOCK_START = "2026-04-15T12:00:00.000Z";
const BOOTSTRAP_SEED = 17;
const BOOTSTRAP_SAMPLES = 2000;

export interface BenchmarkOptions {
  seeds?: number[];
  priceTable?: PriceTable;
  model?: string;
  perRunUsd?: number;
  totalUsd?: number;
  tolerance?: number;
  bootstrapSamples?: number;
  bootstrapSeed?: number;
}

export interface SpendView {
  calls: number;
  microUsd: number;
  usd: string;
  simulatedLatencyMs: number;
}

export interface RateView {
  successes: number;
  trials: number;
  rate: number;
}

export interface OfflineReport {
  schemaVersion: 2;
  harness: "loopiter-offline-kb-qa";
  phase: 0;
  task: "internal-kb-qa";
  liveCalls: 0;
  provider: "mock";
  model: string;
  description: string;
  seeds: number[];
  priceTable: PriceTable;
  caps: { perRunUsd: string; totalUsd: string; perRunMicroUsd: number; totalMicroUsd: number };
  tolerance: number;
  retrieval: { frozen: true; note: string };
  splits: { train: string; dev: string[]; heldOut: string; note: string };
  interval: {
    primary: "seed-bootstrap-percentile";
    confidence: 0.95;
    bootstrapSamples: number;
    bootstrapSeed: number;
    wilsonZ: number;
    note: string;
  };
  arms: {
    baseline: ArmSummary;
    candidate: ArmSummary;
  };
  perSeed: {
    seed: number;
    baseline: { heldOut: RateView; spend: SpendView };
    candidate: {
      heldOut: RateView;
      spend: SpendView;
      loopSpend: SpendView;
      scoringSpend: SpendView;
      state: string;
      reason: string;
      servedArtifactVersion: string;
      baselineArtifactVersion: string;
    };
  }[];
  comparisonBudget: {
    adhered: boolean;
    totalMicroUsd: number;
    totalUsd: string;
    capMicroUsd: number;
  };
  regression: RegressionEvidence & {
    passed: boolean;
    failures: string[];
  };
  budget: BudgetEvidence & {
    passed: boolean;
    failures: string[];
    perRunCapUsd: string;
    totalCapUsd: string;
    totalUsd: string;
  };
  passed: boolean;
}

interface ArmSummary {
  heldOutSuccessRate: number;
  bootstrap: {
    mean: number;
    lower: number;
    upper: number;
    samples: number;
    seed: number;
  };
  wilsonPooled: {
    successes: number;
    trials: number;
    lower: number;
    upper: number;
  };
  spend: SpendView;
}

interface LoopOutcome {
  state: string;
  reason: string;
  transitions: { state: string; reason: string }[];
  servedFragment: string;
  servedVersion: string;
  baselineVersion: string;
  heldOut: RateView;
  loopSpend: SpendView;
  scoringSpend: SpendView;
  spend: SpendView;
  leakedTestIds: string[];
}

export async function runOfflineBenchmark(
  options: BenchmarkOptions = {},
): Promise<OfflineReport> {
  const seeds = options.seeds ?? [1, 2, 3, 4, 5];
  if (seeds.length < 1) throw new Error("At least one seed is required.");
  if (new Set(seeds).size !== seeds.length) throw new Error("Seeds must be unique.");
  const priceTable = options.priceTable ?? defaultPriceTable;
  const model = options.model ?? DEFAULT_MODEL;
  const tolerance = options.tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error("Tolerance must be a non-negative finite number.");
  const perRunMicroUsd = usdToMicro(options.perRunUsd ?? 1);
  const totalMicroUsd = usdToMicro(options.totalUsd ?? 5);
  const bootstrapSamples = options.bootstrapSamples ?? BOOTSTRAP_SAMPLES;
  const bootstrapSeed = options.bootstrapSeed ?? BOOTSTRAP_SEED;
  const comparison = new SpendLedger({ perRunMicroUsd, totalMicroUsd });
  const perSeed = [];
  for (const seed of seeds) {
    const split = buildSplit(seed);
    comparison.beginRun();
    const frozenHeldOut = scoreCharged(
      baselineFragment(),
      split.test,
      comparison,
      priceTable,
      model,
      seed,
    );
    if (comparison.stopReason)
      throw new Error("Comparison baseline hit the spend cap. Raise the caps.");
    const baselineSpend = view(comparison);
    comparison.beginRun();
    const candidate = await runLoop({
      seed,
      split,
      ledger: comparison,
      priceTable,
      model,
      proposal: "improve",
      observation: "honest",
      scenario: "candidate",
    });
    if (candidate.leakedTestIds.length)
      throw new Error(
        `Held-out ids were exposed to the loop: ${candidate.leakedTestIds.join(", ")}`,
      );
    perSeed.push({
      seed,
      baseline: { heldOut: frozenHeldOut, spend: baselineSpend },
      candidate: {
        heldOut: candidate.heldOut,
        spend: candidate.spend,
        loopSpend: candidate.loopSpend,
        scoringSpend: candidate.scoringSpend,
        state: candidate.state,
        reason: candidate.reason,
        servedArtifactVersion: candidate.servedVersion,
        baselineArtifactVersion: candidate.baselineVersion,
      },
    });
  }
  const regression = await runRegressionCheck({
    seed: seeds[0]!,
    priceTable,
    model,
    tolerance,
  });
  const budget = await runBudgetCheck({ priceTable, model });
  const regressionJudgment = judgeRegression(regression);
  const budgetJudgment = judgeBudget(budget);
  const baselineRates = perSeed.map((row) => row.baseline.heldOut.rate);
  const candidateRates = perSeed.map((row) => row.candidate.heldOut.rate);
  const baselineWilson = wilsonInterval(
    sum(perSeed.map((row) => row.baseline.heldOut.successes)),
    sum(perSeed.map((row) => row.baseline.heldOut.trials)),
  );
  const candidateWilson = wilsonInterval(
    sum(perSeed.map((row) => row.candidate.heldOut.successes)),
    sum(perSeed.map((row) => row.candidate.heldOut.trials)),
  );
  const baselineBootstrap = bootstrapMeanInterval(baselineRates, {
    samples: bootstrapSamples,
    seed: bootstrapSeed,
  });
  const candidateBootstrap = bootstrapMeanInterval(candidateRates, {
    samples: bootstrapSamples,
    seed: bootstrapSeed,
  });
  const comparisonAdhered =
    comparison.stopReason === null &&
    comparison.totalMicroUsd <= totalMicroUsd &&
    perSeed.every(
      (row) =>
        row.baseline.spend.microUsd <= perRunMicroUsd &&
        row.candidate.spend.microUsd <= perRunMicroUsd,
    );
  const candidateCompleted = perSeed.every((row) => row.candidate.state === "completed");
  const passed =
    regressionJudgment.passed &&
    budgetJudgment.passed &&
    comparisonAdhered &&
    candidateCompleted &&
    candidateBootstrap.mean > baselineBootstrap.mean;
  return {
    schemaVersion: 2,
    harness: "loopiter-offline-kb-qa",
    phase: 0,
    task: "internal-kb-qa",
    liveCalls: 0,
    provider: "mock",
    model,
    description:
      "Frozen baseline versus the SDK autonomous loop on a synthetic internal KB. Retrieval is frozen and can return a distractor, miss, or out-of-scope result. The loop may change only the versioned KB fragment. Mock answers slip by seed. Held-out items are scored after the loop and are not part of train or dev.",
    seeds,
    priceTable,
    caps: {
      perRunUsd: formatUsd(perRunMicroUsd),
      totalUsd: formatUsd(totalMicroUsd),
      perRunMicroUsd,
      totalMicroUsd,
    },
    tolerance,
    retrieval: {
      frozen: true,
      note: "Passage ids are chosen from question keywords. The artifact supplies passage text and does not change which passage is retrieved.",
    },
    splits: {
      train: "optimization",
      dev: ["validation", "audit"],
      heldOut: "test",
      note: "The SDK audit partition is a pre-deploy gate, not the held-out test. Test rows are never passed to dataset, propose, or evaluate.",
    },
    interval: {
      primary: "seed-bootstrap-percentile",
      confidence: 0.95,
      bootstrapSamples,
      bootstrapSeed,
      wilsonZ: baselineWilson.z,
      note: "Primary interval: percentile bootstrap of the mean held-out success rate, resampling seeds with replacement. Endpoints use linear interpolation between order statistics (NumPy percentile type 7). The seed is the resampling unit. Each seed has its own mock reliability and per-row slip draws, so the seed rates are not identical and the interval has width. Wilson score intervals are also reported on pooled held-out trials and treat those trials as i.i.d. Bernoulli draws; that is a convenience view of this synthetic set, not a claim about production traffic.",
    },
    arms: {
      baseline: armSummary(baselineRates, baselineBootstrap, baselineWilson, perSeed.map((row) => row.baseline.spend)),
      candidate: armSummary(candidateRates, candidateBootstrap, candidateWilson, perSeed.map((row) => row.candidate.spend)),
    },
    perSeed,
    comparisonBudget: {
      adhered: comparisonAdhered,
      totalMicroUsd: comparison.totalMicroUsd,
      totalUsd: formatUsd(comparison.totalMicroUsd),
      capMicroUsd: totalMicroUsd,
    },
    regression: {
      ...regression,
      passed: regressionJudgment.passed,
      failures: regressionJudgment.failures,
    },
    budget: {
      ...budget,
      passed: budgetJudgment.passed,
      failures: budgetJudgment.failures,
      perRunCapUsd: formatUsd(budget.perRunCapMicroUsd),
      totalCapUsd: formatUsd(budget.totalCapMicroUsd),
      totalUsd: formatUsd(budget.totalMicroUsd),
    },
    passed,
  };
}

export function renderMarkdown(report: OfflineReport): string {
  const lines = [
    "# Offline KB-QA benchmark",
    "",
    "Phase 0 mocked run. Live model calls: 0. Provider: mock.",
    "",
    `| Arm | Held-out success | 95% seed bootstrap CI | Wilson pooled | Simulated cost | Simulated latency |`,
    `| --- | ---: | --- | --- | ---: | ---: |`,
    tableRow("Frozen baseline", report.arms.baseline),
    tableRow("Autonomous candidate", report.arms.candidate),
    "",
    `Seeds: ${report.seeds.join(", ")}. Primary interval resamples those seeds (${report.interval.bootstrapSamples} draws, seed ${report.interval.bootstrapSeed}).`,
    "",
    report.interval.note,
    "",
    "## Per seed",
    "",
    "| Seed | Baseline | Candidate | Candidate state | Candidate cost |",
    "| ---: | ---: | ---: | --- | ---: |",
    ...report.perSeed.map(
      (row) =>
        `| ${row.seed} | ${row.baseline.heldOut.rate.toFixed(4)} | ${row.candidate.heldOut.rate.toFixed(4)} | ${row.candidate.state} | $${row.candidate.spend.usd} |`,
    ),
    "",
    "## Regression check",
    "",
    report.regression.passed
      ? `PASS. Tolerance ${report.tolerance}.`
      : `FAIL. ${report.regression.failures.join(" ")}`,
    "",
    `Harmful candidate: final state \`${report.regression.harmful.finalState}\` (${report.regression.harmful.finalReason}). Served held-out ${report.regression.harmful.servedRate.toFixed(4)} versus baseline ${report.regression.harmful.baselineRate.toFixed(4)}. Counterfactual held-out if that candidate had been served: ${report.regression.harmful.counterfactualRate.toFixed(4)}.`,
    "",
    `Observation rollback: final state \`${report.regression.rollback.finalState}\` (${report.regression.rollback.finalReason}). Served version matches baseline: ${report.regression.rollback.servedVersion === report.regression.rollback.baselineVersion}. Served held-out ${report.regression.rollback.servedRate.toFixed(4)}.`,
    "",
    "## Budget check",
    "",
    report.budget.passed
      ? "PASS. The run stopped at the cap and simulated spend stayed within both caps."
      : `FAIL. ${report.budget.failures.join(" ")}`,
    "",
    `Per-run cap ${report.budget.perRunCapUsd} USD. Total cap ${report.budget.totalCapUsd} USD. Spent ${report.budget.totalUsd} USD.`,
    "",
    ...report.budget.runs.map(
      (run, index) =>
        `- Run ${index + 1}: stop \`${run.stopReason}\`, state \`${run.finalState}\` (${run.finalReason}), spent ${formatUsd(run.microUsd)} USD, ${run.calls} charged calls, ${run.refusedCalls} refused.`,
    ),
    "",
    `Comparison spend ${report.comparisonBudget.totalUsd} USD against cap ${formatUsd(report.comparisonBudget.capMicroUsd)} USD. Adhered: ${report.comparisonBudget.adhered}.`,
    "",
    `Overall: ${report.passed ? "PASS" : "FAIL"}.`,
    "",
  ];
  return lines.join("\n");
}

async function runRegressionCheck(input: {
  seed: number;
  priceTable: PriceTable;
  model: string;
  tolerance: number;
}): Promise<RegressionEvidence> {
  const split = buildSplit(input.seed);
  const loose = looseLedger();
  const harmful = await runLoop({
    seed: input.seed,
    split,
    ledger: loose,
    priceTable: input.priceTable,
    model: input.model,
    proposal: "harmful",
    observation: "honest",
    scenario: "harmful",
  });
  const counterfactual = successCount(harmfulFragment(), rowsOf(split.test), input.seed);
  const rollbackLedger = looseLedger();
  const rollback = await runLoop({
    seed: input.seed,
    split,
    ledger: rollbackLedger,
    priceTable: input.priceTable,
    model: input.model,
    proposal: "improve",
    observation: "fail",
    scenario: "rollback",
  });
  const baseline = successCount(baselineFragment(), rowsOf(split.test), input.seed);
  return {
    tolerance: input.tolerance,
    harmful: {
      finalState: harmful.state,
      finalReason: harmful.reason,
      sawValidationFailure: harmful.transitions.some(
        (step) => step.reason === "validation_failed",
      ),
      baselineRate: baseline.rate,
      servedRate: harmful.heldOut.rate,
      counterfactualRate: counterfactual.rate,
      servedVersion: harmful.servedVersion,
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
      servedVersion: rollback.servedVersion,
      baselineVersion: rollback.baselineVersion,
    },
  };
}

async function runBudgetCheck(input: {
  priceTable: PriceTable;
  model: string;
}): Promise<BudgetEvidence> {
  const predict = quote("predict", input.priceTable, input.model);
  const propose = quote("propose", input.priceTable, input.model);
  const perRunCapMicroUsd = propose.microUsd + 2 * predict.microUsd;
  const totalCapMicroUsd = perRunCapMicroUsd + propose.microUsd + predict.microUsd;
  const ledger = new SpendLedger({
    perRunMicroUsd: perRunCapMicroUsd,
    totalMicroUsd: totalCapMicroUsd,
  });
  const runs: BudgetEvidence["runs"] = [];
  for (const seed of [11, 12]) {
    ledger.beginRun();
    const outcome = await runLoop({
      seed,
      split: buildSplit(seed),
      ledger,
      priceTable: input.priceTable,
      model: input.model,
      proposal: "improve",
      observation: "honest",
      scenario: "budget",
    });
    runs.push({
      stopReason: ledger.stopReason,
      finalState: outcome.state,
      finalReason: outcome.reason,
      microUsd: ledger.runMicroUsd,
      calls: ledger.runCalls,
      refusedCalls: ledger.refusedCalls,
    });
  }
  return {
    perRunCapMicroUsd,
    totalCapMicroUsd,
    totalMicroUsd: ledger.totalMicroUsd,
    runs,
  };
}

async function runLoop(input: {
  seed: number;
  split: TaskSplit;
  ledger: SpendLedger;
  priceTable: PriceTable;
  model: string;
  proposal: "improve" | "harmful";
  observation: "honest" | "fail";
  scenario: string;
}): Promise<LoopOutcome> {
  const exposed = new Set<string>();
  const watch = (rows: readonly DatasetRow[]) => {
    for (const row of rows) exposed.add(row.id);
  };
  const clock = { now: new Date(CLOCK_START) };
  const store = new InMemoryStore();
  const namespace = `benchmark/kb-qa/${input.scenario}/${input.seed}`;
  const loop = new FeedbackLoop({
    store,
    namespace,
    clock: () => clock.now,
    maximumPayloadBytes: 1_048_576,
  });
  try {
    const registry = new MemoryRegistry({ fragment: baselineFragment() });
    const baselineVersion = registry.version;
    let workflow: ImprovementWorkflow;
    const policy = policyFor();
    const common = {
      id: "internal-kb-qa",
      version: "1",
      policy,
      registry,
      dataset: async (): Promise<DatasetSnapshot> => {
        watch(input.split.optimization);
        watch(input.split.validation);
        watch(input.split.audit);
        return {
          version: `kb-qa-seed-${input.seed}`,
          optimization: input.split.optimization,
          validation: input.split.validation,
          audit: input.split.audit,
        };
      },
      observe: async (
        observation: Parameters<ImprovementWorkflow["observe"]>[0],
        context: CallbackContext,
      ) => {
        const current = await registry.current();
        const fragment = fragmentOf(current.artifact);
        let errors = 0;
        for (const row of input.split.production) {
          await metered(context, input.ledger, input.priceTable, input.model, "predict");
          errors += Number(answer(fragment, row.question, input.seed) !== row.label);
        }
        if (input.observation === "fail") errors = input.split.production.length;
        const identity = await workflow.artifact(readContext());
        return {
          artifactVersion: registry.version,
          configurationHash: identity.configurationHash,
          startedAt: observation.deployedAt,
          endedAt: clock.now.toISOString(),
          complete: true,
          unitIds: input.split.production.map((row) => row.id),
          metrics: { errors: errors / input.split.production.length },
        };
      },
    };
    workflow = promptWorkflow({
      ...common,
      modelId: input.model,
      labels: labels(),
      propose: async (examples, context) => {
        watch(examples);
        const current = fragmentOf(await registry.get(registry.version));
        const fragment =
          input.proposal === "harmful"
            ? harmfulFragment()
            : improveFragment(
                current,
                examples.map((row) => ({
                  question: questionText(row),
                  label: String(row.label),
                })),
              );
        await metered(context, input.ledger, input.priceTable, input.model, "propose");
        return [fragment];
      },
      predict: async ({ fragment, text }, context) => {
        await metered(context, input.ledger, input.priceTable, input.model, "predict");
        return {
          label: answer(fragment, text, input.seed),
          cost: 0,
          latencyMs: quote("predict", input.priceTable, input.model).latencyMs,
        };
      },
    });
    const fingerprint = (await workflow.artifact(readContext())).configurationHash;
    registry.fingerprint = () => fingerprint;
    const controller = new ImprovementController(loop, {
      workflows: [workflow],
      mode: "autonomous",
      selfImproving: true,
    });
    const transitions: { state: string; reason: string }[] = [];
    let result: TickResult | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      result = await controller.tick(workflow.id);
      transitions.push({ state: result.state, reason: result.reason });
      if (TERMINAL.has(result.state) || input.ledger.stopReason) break;
      if (result.state === "observing")
        clock.now = new Date(clock.now.getTime() + 7_200_000);
    }
    if (!result) throw new Error("Controller produced no tick.");
    if (!TERMINAL.has(result.state))
      throw new Error(`Loop did not finish: ${result.state} (${result.reason}).`);
    const loopSpend = view(input.ledger);
    const served = await registry.current();
    const servedFragment = fragmentOf(served.artifact);
    const heldOut = input.ledger.stopReason
      ? { successes: 0, trials: input.split.test.length, rate: 0 }
      : scoreCharged(
          servedFragment,
          input.split.test,
          input.ledger,
          input.priceTable,
          input.model,
          input.seed,
        );
    const spend = view(input.ledger);
    const testIds = new Set(input.split.test.map((row) => row.id));
    return {
      state: result.state,
      reason: result.reason,
      transitions,
      servedFragment,
      servedVersion: served.version,
      baselineVersion,
      heldOut,
      loopSpend,
      scoringSpend: diff(loopSpend, spend),
      spend,
      leakedTestIds: [...exposed].filter((id) => testIds.has(id)),
    };
  } finally {
    await loop.close();
  }
}

function scoreCharged(
  fragment: string,
  rows: readonly DatasetRow[],
  ledger: SpendLedger,
  table: PriceTable,
  model: string,
  seed: number,
): RateView {
  let successes = 0;
  for (const row of rows) {
    const priced = quote("predict", table, model);
    if (!ledger.tryCharge(priced.microUsd, priced.latencyMs))
      throw new Error(`Held-out scoring hit the spend cap (${ledger.stopReason}).`);
    successes += Number(answer(fragment, questionText(row), seed) === String(row.label));
  }
  return { successes, trials: rows.length, rate: successes / rows.length };
}

async function metered(
  context: CallbackContext,
  ledger: SpendLedger,
  table: PriceTable,
  model: string,
  kind: "propose" | "predict",
): Promise<void> {
  const priced = quote(kind, table, model);
  await context.meter(priced.tokens, async () => {
    if (!ledger.tryCharge(priced.microUsd, priced.latencyMs))
      throw new LoopiterError(
        "spend_cap",
        `Simulated ${ledger.stopReason ?? "spend"} cap reached.`,
      );
    return { value: true, tokens: priced.tokens };
  });
}

function policyFor() {
  const auditCalls = SPLIT_COUNTS.audit * 2;
  const loopCalls =
    1 +
    SPLIT_COUNTS.validation * 2 +
    auditCalls +
    SPLIT_COUNTS.production;
  return {
    version: "offline-kb-qa-v2",
    target: { kind: "prompt" as const, key: "internal-kb" },
    changeSchema: {
      type: "object" as const,
      properties: {
        fragment: { type: "string" as const, maxLength: 800 },
      },
      required: ["fragment"],
      additionalProperties: false as const,
    },
    objective: {
      metric: "accuracy",
      direction: "maximize" as const,
      minimumImprovement: 0.05,
      range: [0, 1] as [number, number],
      alpha: 0.05,
    },
    guardrails: [
      { metric: "accuracy", comparator: "gte" as const, value: ACCURACY_FLOOR },
      { metric: "latencyMs", comparator: "lte" as const, value: 100 },
    ],
    trustedSources: ["verified-export"],
    minimumNewUnits: SPLIT_COUNTS.train,
    minimumValidationUnits: SPLIT_COUNTS.validation,
    minimumAuditUnits: SPLIT_COUNTS.audit,
    outcomeMaturityMs: 3_600_000,
    maximumRows: SPLIT_COUNTS.audit,
    daily: {
      modelRequests: loopCalls + 50,
      tokens: (loopCalls + 50) * 200,
      deployments: 1,
    },
    callbackReservation: {
      modelRequests: auditCalls + 20,
      tokens: (auditCalls + 20) * 200,
    },
    cooldownMs: 0,
    rollout: { mode: "immediate" as const },
    observation: {
      minimumDurationMs: 3_600_000,
      timeoutMs: 86_400_000,
      minimumUnits: SPLIT_COUNTS.production,
      guardrails: [
        {
          metric: "errors",
          comparator: "lte" as const,
          value: OBSERVATION_ERROR_CEILING,
        },
      ],
      onTimeout: "rollback" as const,
      onFailure: "rollback" as const,
    },
    onInsufficientEvidence: "wait" as const,
    onUncertainDeployment: "reconcile" as const,
    maximumCandidates: 1,
    maximumProposalCalls: 1,
    maximumConsecutiveFailures: 3,
  };
}

function looseLedger(): SpendLedger {
  return new SpendLedger({
    perRunMicroUsd: usdToMicro(1),
    totalMicroUsd: usdToMicro(1),
  });
}

function view(ledger: SpendLedger): SpendView {
  return {
    calls: ledger.runCalls,
    microUsd: ledger.runMicroUsd,
    usd: formatUsd(ledger.runMicroUsd),
    simulatedLatencyMs: ledger.runLatencyMs,
  };
}

function diff(before: SpendView, after: SpendView): SpendView {
  return {
    calls: after.calls - before.calls,
    microUsd: after.microUsd - before.microUsd,
    usd: formatUsd(after.microUsd - before.microUsd),
    simulatedLatencyMs: after.simulatedLatencyMs - before.simulatedLatencyMs,
  };
}

function armSummary(
  rates: number[],
  bootstrap: { mean: number; lower: number; upper: number; samples: number; seed: number },
  wilson: { successes: number; trials: number; lower: number; upper: number },
  spends: SpendView[],
): ArmSummary {
  const microUsd = sum(spends.map((spend) => spend.microUsd));
  return {
    heldOutSuccessRate: bootstrap.mean,
    bootstrap: {
      mean: bootstrap.mean,
      lower: bootstrap.lower,
      upper: bootstrap.upper,
      samples: bootstrap.samples,
      seed: bootstrap.seed,
    },
    wilsonPooled: {
      successes: wilson.successes,
      trials: wilson.trials,
      lower: wilson.lower,
      upper: wilson.upper,
    },
    spend: {
      calls: sum(spends.map((spend) => spend.calls)),
      microUsd,
      usd: formatUsd(microUsd),
      simulatedLatencyMs: sum(spends.map((spend) => spend.simulatedLatencyMs)),
    },
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function rowsOf(rows: readonly DatasetRow[]): { question: string; label: string }[] {
  return rows.map((row) => ({ question: questionText(row), label: String(row.label) }));
}

function tableRow(name: string, arm: ArmSummary): string {
  return `| ${name} | ${arm.heldOutSuccessRate.toFixed(4)} | [${arm.bootstrap.lower.toFixed(4)}, ${arm.bootstrap.upper.toFixed(4)}] | [${arm.wilsonPooled.lower.toFixed(4)}, ${arm.wilsonPooled.upper.toFixed(4)}] | $${arm.spend.usd} | ${arm.spend.simulatedLatencyMs} ms |`;
}

function readContext(): CallbackContext {
  return {
    operationId: "benchmark-read",
    signal: new AbortController().signal,
    meter: async () => {
      throw new Error("Benchmark artifact reads do not call a model.");
    },
  };
}

function fragmentOf(artifact: JsonValue): string {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    throw new Error("KB artifact must be an object.");
  const fragment = artifact.fragment;
  if (typeof fragment !== "string") throw new Error("KB artifact is missing fragment.");
  return fragment;
}

/** In-memory registry shaped like the autonomous example. Development only. */
class MemoryRegistry implements ArtifactRegistry {
  version: string;
  private artifacts = new Map<string, JsonValue>();
  private receipts = new Map<string, DeploymentReceipt | null>();
  fingerprint: (artifact: JsonValue) => string = hash;
  constructor(initial: JsonValue) {
    this.version = hash(initial);
    this.artifacts.set(this.version, initial);
  }
  async current() {
    return { version: this.version, artifact: await this.get(this.version) };
  }
  async get(version: string | null) {
    if (!version || !this.artifacts.has(version)) throw new Error("Unknown artifact version.");
    return structuredClone(this.artifacts.get(version)!);
  }
  async apply(request: DeploymentRequest) {
    return this.change(request, request.candidate.contentHash, request.candidate.proposedChange);
  }
  async rollback(request: DeploymentRequest) {
    return this.change(
      request,
      request.attempt.restoreArtifactVersion!,
      await this.get(request.attempt.restoreArtifactVersion!),
    );
  }
  async change(request: DeploymentRequest, version: string, artifact: JsonValue) {
    if (this.receipts.has(request.attempt.id)) {
      const prior = this.receipts.get(request.attempt.id);
      if (!prior) throw new Error("Fenced");
      return prior;
    }
    if (this.version !== request.attempt.expectedArtifactVersion)
      throw new Error("Version conflict");
    if (
      request.attempt.operation === "apply" &&
      request.candidate.baseline?.configurationHash !==
        this.fingerprint(this.artifacts.get(this.version)!)
    )
      throw new Error("Configuration conflict");
    const receipt: DeploymentReceipt = {
      attemptId: request.attempt.id,
      artifactVersion: version,
      previousArtifactVersion: this.version,
    };
    this.artifacts.set(version, structuredClone(artifact));
    this.version = version;
    this.receipts.set(request.attempt.id, receipt);
    return receipt;
  }
  async inspect(request: DeploymentRequest) {
    const receipt = this.receipts.get(request.attempt.id);
    if (receipt) return { status: "applied" as const, receipt };
    this.receipts.set(request.attempt.id, null);
    return { status: "not_applied" as const };
  }
}
