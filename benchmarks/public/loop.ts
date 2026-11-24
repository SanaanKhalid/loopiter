/**
 * One-shot arm and the autonomous controller. Held-out rows are scored only
 * after those arms return, and only through the held-out type.
 */
import { hash } from "../../src/utils.js";
import {
  gateParameters,
  minimumDecisiveFloor,
  type GateItem,
  type GateParameters,
} from "../../src/acceptance-gate.js";
import {
  FeedbackLoop,
  ImprovementController,
  InMemoryStore,
  type CallbackContext,
  type DatasetRow,
  type TickResult,
} from "../../src/index.js";
import {
  appendRound,
  emptySeedLog,
  noteCandidate,
  noteRolledBack,
  noteTransition,
  promptHash,
  settleSeed,
  type SeedDecisionLog,
} from "./decisions.js";
import { longestExample, sizedReservations } from "./budget.js";
import {
  CLOCK_START,
  assertWithinCap,
} from "./constants.js";
import { promptPolicy, watchStepMs } from "./policy.js";
import { FOLLOW_PROPOSE_SEED, PROPOSE_SELECTION_SEED } from "./propose-bound.js";
import { mockRewrite } from "./propose.js";
import { PromptRegistry, fragmentOf } from "./registry.js";
import {
  idsOf,
  poolDatasetRow,
  splitAuditRows,
  type HeldOutRow,
  type PoolRow,
  type PublicSplit,
} from "./splits.js";
import type {
  BenchmarkTask,
  InstructionMark,
  ModelRunner,
  PredictCall,
  PublicExample,
  RowScore,
} from "./task.js";
import {
  TERMINAL,
  createPromptWorkflow,
  primaryOf,
  readContext,
  type BatchCase,
} from "./workflow.js";

/** One held-out question. `correct` is the primary metric. `failed` is a provider failure. */
export interface QuestionResult {
  id: string;
  correct: boolean;
  failed: boolean;
}

export interface RateDraft {
  successes: number;
  trials: number;
  rate: number;
  loose: number | null;
  f1: number | null;
  instructionStrict: number | null;
  instructionLoose: number | null;
  items: QuestionResult[];
}

export interface ArmRun {
  fragment: string;
  version: string;
  baselineVersion: string;
  heldOut: RateDraft;
  ungated: RateDraft | null;
  /**
   * The served prompt hash matched the baseline prompt. `heldOut` is that
   * baseline result, so the paired difference is zero.
   */
  servedReused: boolean;
  /**
   * The ungated prompt hash matched the baseline prompt. `ungated` is that
   * baseline result. False when this phase did not propose.
   */
  ungatedReused: boolean;
  gates: "none" | "improvement-controller";
  state: string;
  reason: string;
  detail: string | null;
  transitions: { state: string; reason: string; at?: string; cause?: string }[];
  readIds: string[];
  decisions: SeedDecisionLog | null;
  /** Fragment returned by propose. Null when this phase did not propose. */
  proposedFragment: string | null;
  /** Baseline scores for the optimization rows. Reused across propose calls in one seed. */
  baselineFeedback: BaselineFeedback | null;
}

/** Baseline held-out result for one seed, with the hash of the prompt that produced it. */
export interface BaselineHeldOut {
  promptHash: string;
  result: RateDraft;
}

export interface BaselineFeedback {
  byId: Map<string, InstructionMark[]>;
  predictionById: Map<string, string>;
  scoreById: Map<string, number>;
  ids: string[];
}

export function mockRunner<T extends PublicExample>(task: BenchmarkTask<T>): ModelRunner<T> {
  return {
    async answer(prompt, row, context) {
      const text = task.mockAnswer(prompt, row);
      if (context) await context.meter(64, async () => ({ value: true, tokens: 32 }));
      return { text, latencyMs: 1 };
    },
    async propose(request, context) {
      const fragment = mockRewrite(request, task.promptCap, task.feedbackPredicts);
      if (context) await context.meter(64, async () => ({ value: true, tokens: 32 }));
      return fragment;
    },
  };
}

export async function scoreHeldOut<T extends PublicExample>(
  task: BenchmarkTask<T>,
  runner: ModelRunner<T>,
  prompt: string,
  rows: readonly HeldOutRow<T>[],
  call?: PredictCall,
): Promise<RateDraft> {
  const answers = [];
  for (const row of rows) {
    runner.afterPredict?.();
    const answer = await runner.answer(prompt, row.example, null, call);
    runner.afterPredict?.();
    answers.push({ response: answer.text, row: row.example, failed: answer.failed === true });
  }
  runner.afterPredict?.();
  const scores = await task.scoreMany(answers);
  return draftOf(
    scores,
    answers.map((item) => ({ id: item.row.id, failed: item.failed })),
  );
}

export async function runOneShot<T extends PublicExample>(input: {
  task: BenchmarkTask<T>;
  split: PublicSplit<T>;
  runner: ModelRunner<T>;
  mode: "improve" | "harmful";
}): Promise<ArmRun> {
  const readIds: string[] = [];
  const registry = new PromptRegistry(input.task.baselinePrompt);
  const baselineVersion = registry.version;
  const { fragment, feedback: scored } = await rewrite(
    input.task,
    input.split,
    input.runner,
    input.mode,
    null,
  );
  for (const id of scored.ids) readIds.push(id);
  registry.serve(fragment);
  const heldOut = await scoreHeldOut(input.task, input.runner, registry.fragment(), input.split.heldOut, {
    arm: "one-shot",
    split: "held-out",
    planned: input.split.heldOut.length,
  });
  return {
    fragment: registry.fragment(),
    version: registry.version,
    baselineVersion,
    heldOut,
    ungated: heldOut,
    servedReused: false,
    ungatedReused: false,
    gates: "none",
    state: "applied",
    reason: "ungated",
    detail: null,
    transitions: [],
    readIds,
    decisions: null,
    proposedFragment: fragment,
    baselineFeedback: scored,
  };
}

export async function runController<T extends PublicExample>(input: {
  task: BenchmarkTask<T>;
  split: PublicSplit<T>;
  runner: ModelRunner<T>;
  mode: "improve" | "harmful";
  observation: "honest" | "fail";
  minimumImprovement: number;
  minimumEffect?: number;
  confidence?: number;
  bootstrapSamples?: number;
  bootstrapSeed?: number;
  minimumItems?: number;
  minimumValidationDecisive?: number;
  minimumAuditDecisive?: number;
  /** When set, this rewrite is judged against the baseline before the controller loop. */
  oneShotFragment?: string;
  /** Controller proposal is this fragment. Used for the one-shot gate run. */
  fixedFragment?: string;
  /** Audit rows for this run. Disjoint from the other candidate's audit rows. */
  auditRows?: PublicSplit<T>["audit"];
  /** Registry starts here. The reported baseline stays the task baseline. */
  initialPrompt?: string;
  /** Leave the served-prompt check to the caller that combines phases. */
  deferServedCheck?: boolean;
  /** Leave held-out scoring to the caller that combines phases. */
  deferHeldOut?: boolean;
  /**
   * Baseline held-out result for this seed. A served or ungated prompt whose
   * hash matches is not scored again.
   */
  baselineHeldOut?: BaselineHeldOut;
  /** Baseline optimization scores already computed for this seed. */
  baselineFeedback?: BaselineFeedback;
  /** Example sample for propose. The follow-up uses a different seed. */
  exampleSeed?: number;
  decisionLog?: SeedDecisionLog;
  batchSize: number;
  observeChunk: number;
  latencyMs: number;
  modelId: string;
  scenario: string;
  tickLimit: number;
  predictMaxOutputTokens?: number;
  proposeMaxOutputTokens?: number;
  timeouts?: { callbackTimeoutMs: number; tickTimeoutMs: number };
}): Promise<ArmRun> {
  if (input.oneShotFragment && !input.fixedFragment) return runOneShotThenController(input);
  const readIds: string[] = [];
  const watch = (rows: readonly { id: string }[]) => {
    for (const row of rows) {
      readIds.push(row.id);
      if (heldOut.has(row.id))
        throw new Error(`Held-out row ${row.id} reached the controller.`);
    }
  };
  const heldOut = new Set(idsOf(input.split.heldOut));
  const validationIds = new Set(input.split.validation.map((row) => row.example.id));
  const auditIds = new Set(input.split.audit.map((row) => row.example.id));
  const pool = new Map<string, T>();
  for (const row of [
    ...input.split.optimization,
    ...input.split.validation,
    ...input.split.audit,
    ...input.split.production,
  ]) {
    if (heldOut.has(row.example.id))
      throw new Error(`Held-out row ${row.example.id} is in the pool.`);
    pool.set(row.example.id, row.example);
  }
  const feedback =
    input.baselineFeedback ??
    (input.fixedFragment
      ? emptyFeedback(input.split.optimization.map((row) => row.example))
      : await feedbackFor(input.task, input.split, input.runner, input.mode, "controller"));
  for (const id of feedback.ids) readIds.push(id);
  const clock = { now: new Date(CLOCK_START) };
  const store = new InMemoryStore();
  const namespace = `benchmark/${input.task.id}/${input.scenario}/${input.split.seed}`;
  const loop = new FeedbackLoop({
    store,
    namespace,
    clock: () => clock.now,
    maximumPayloadBytes: 16_777_216,
    ...(input.timeouts ? { callbackTimeoutMs: input.timeouts.callbackTimeoutMs } : {}),
  });
  const registry = new PromptRegistry(input.initialPrompt ?? input.task.baselinePrompt);
  const baselineVersion = new PromptRegistry(input.task.baselinePrompt).version;
  const rule = gateParameters({
    ...(input.minimumEffect !== undefined ? { minimumEffect: input.minimumEffect } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.bootstrapSamples !== undefined ? { samples: input.bootstrapSamples } : {}),
    ...(input.bootstrapSeed !== undefined ? { seed: input.bootstrapSeed } : {}),
    ...(input.minimumItems !== undefined ? { minimumItems: input.minimumItems } : {}),
  });
  const decisionLog = input.decisionLog ?? emptySeedLog(input.split.seed, input.task.baselinePrompt);
  decisionLog.complete = false;
  const recorded: { split: "validation" | "audit"; promptHash: string; items: GateItem[] }[] = [];
  let proposal: string | null = null;
  let observeCursor = 0;
  let observeWrong = 0;
  let observeScored = 0;
  try {
    const auditSource = input.auditRows ?? input.split.audit;
    // The one-shot rewrite and its follow-up each pass one half of the audit
    // split. This phase's audit unit count is the rows it actually scores.
    const sizes = {
      optimization: input.split.optimization.length,
      validation: input.split.validation.length,
      audit: auditSource.length,
      production: input.split.production.length,
      heldOut: input.split.heldOut.length,
    };
    const predictMax = input.predictMaxOutputTokens ?? input.task.predict.defaultValue;
    const proposeMax = input.proposeMaxOutputTokens ?? input.task.propose.defaultValue;
    const examples = [
      ...input.split.optimization,
      ...input.split.validation,
      ...input.split.audit,
      ...input.split.production,
      ...input.split.heldOut,
    ].map((row) => row.example);
    const reservations = sizedReservations({
      task: input.task,
      prompt: "x".repeat(input.task.promptCap),
      predictRow: longestExample(input.task, examples),
      proposeRows: input.split.optimization.map((row) => row.example),
      predictMaxOutputTokens: predictMax,
      proposeMaxOutputTokens: proposeMax,
      deployment: input.modelId,
    });
    const validationDecisive =
      input.minimumValidationDecisive ?? minimumDecisiveFloor(rule.confidence);
    const auditDecisive = input.minimumAuditDecisive ?? minimumDecisiveFloor(rule.confidence);
    const policy = promptPolicy({
      taskId: input.task.id,
      promptCap: input.task.promptCap,
      minimumImprovement: input.minimumImprovement,
      minimumEffect: rule.minimumEffect,
      confidence: rule.confidence,
      bootstrapSamples: rule.samples,
      bootstrapSeed: rule.seed,
      minimumItems: rule.minimumItems,
      minimumValidationDecisive: validationDecisive,
      minimumAuditDecisive: auditDecisive,
      sizes,
      latencyMs: input.latencyMs,
      predictReservation: reservations.predict,
      proposeReservation: reservations.propose,
      batchSize: input.batchSize,
      observeChunk: input.observeChunk,
    });
    const datasetRow = (row: PoolRow<T>): DatasetRow => {
      if (row.role !== "pool" || row.partition === "production")
        throw new Error("Only optimization, validation, and audit rows enter the dataset.");
      return poolDatasetRow(
        row,
        input.task.datasetInput(row.example),
        input.task.datasetLabel(row.example),
      );
    };
    const bound: { workflow: ReturnType<typeof createPromptWorkflow> | null } = {
      workflow: null,
    };
    const workflow = createPromptWorkflow({
      id: input.task.id,
      version: "1",
      policy,
      registry,
      modelId: input.modelId,
      promptVersion: input.task.promptVersion,
      promptCap: input.task.promptCap,
      batchSize: input.batchSize,
      dataset: async () => {
        const optimization = input.split.optimization.map(datasetRow);
        const validation = input.split.validation.map(datasetRow);
        const audit = auditSource.map(datasetRow);
        watch(optimization);
        watch(validation);
        watch(audit);
        return {
          version: `${input.task.id}-seed-${input.split.seed}`,
          optimization,
          validation,
          audit,
        };
      },
      observe: async (observation, context) => {
        const served = await registry.current();
        const fragment = fragmentOf(served.artifact);
        const chunk = input.split.production.slice(
          observeCursor,
          observeCursor + input.observeChunk,
        );
        const answers = [];
        for (const row of chunk) {
          if (heldOut.has(row.example.id))
            throw new Error(`Held-out row ${row.example.id} reached observe.`);
          input.runner.afterPredict?.();
          const answer = await input.runner.answer(fragment, row.example, context, {
            arm: "controller",
            split: "production",
            planned: input.split.production.length,
          });
          input.runner.afterPredict?.();
          answers.push({ response: answer.text, row: row.example });
        }
        const scores = answers.length === 0 ? [] : await input.task.scoreMany(answers);
        for (const score of scores) {
          observeScored += 1;
          observeWrong += primaryOf(score) === 1 ? 0 : 1;
        }
        observeCursor += chunk.length;
        const done = observeCursor >= input.split.production.length;
        const errors =
          input.observation === "fail" && done
            ? 1
            : observeScored === 0
              ? 0
              : observeWrong / observeScored;
        if (!bound.workflow) throw new Error("Workflow is not ready.");
        const identity = await bound.workflow.artifact(readContext());
        return {
          artifactVersion: served.version,
          configurationHash: identity.configurationHash,
          startedAt: observation.deployedAt,
          endedAt: clock.now.toISOString(),
          complete: done,
          unitIds: input.split.production.slice(0, observeCursor).map((row) => row.example.id),
          metrics: { errors },
        };
      },
      propose: async (examples, context) => {
        if (input.fixedFragment) {
          proposal = input.fixedFragment;
          noteCandidate(
            decisionLog,
            {
              id: `prompt:${promptHash(input.fixedFragment).slice(0, 12)}`,
              promptHash: promptHash(input.fixedFragment),
              prompt: input.fixedFragment,
            },
            { recordPromptText: true },
          );
          return input.fixedFragment;
        }
        watch(examples);
        const rows = examples.map((row) => exampleOf(pool, row.id));
        const marks = rows.map((row) => {
          const found = feedback.byId.get(row.id);
          if (!found) throw new Error(`Propose is missing feedback for ${row.id}.`);
          return found;
        });
        const current = input.initialPrompt ?? input.task.baselinePrompt;
        const fragment = assertWithinCap(
          await input.runner.propose(
            {
              current,
              rows,
              feedback: marks,
              mode: input.mode,
              exampleSeed: input.exampleSeed ?? PROPOSE_SELECTION_SEED,
              predictions: rows.map((row) => feedback.predictionById.get(row.id) ?? null),
              scores: rows.map((row) => feedback.scoreById.get(row.id) ?? null),
            },
            context,
          ),
          input.task.promptCap,
        );
        proposal = fragment;
        noteCandidate(
          decisionLog,
          {
            id: `prompt:${promptHash(fragment).slice(0, 12)}`,
            promptHash: promptHash(fragment),
            prompt: fragment,
          },
          { recordPromptText: true },
        );
        return fragment;
      },
      scorePair: async (row, baseline, candidate, context) => {
        watch([row]);
        const example = exampleOf(pool, row.id);
        const split = validationIds.has(row.id) ? "validation" : auditIds.has(row.id) ? "audit" : null;
        if (!split) throw new Error(`Row ${row.id} is not in validation or audit.`);
        const planned =
          (split === "validation" ? input.split.validation.length : input.split.audit.length) * 2;
        const site: PredictCall = { arm: "controller", split, planned };
        input.runner.afterPredict?.();
        const left = await input.runner.answer(baseline, example, context, site);
        input.runner.afterPredict?.();
        const right = await input.runner.answer(candidate, example, context, site);
        input.runner.afterPredict?.();
        const [base, next] = await input.task.scoreMany([
          { response: left.text, row: example },
          { response: right.text, row: example },
        ]);
        if (!base || !next) throw new Error("Scorer dropped a row.");
        const scored: BatchCase = {
          id: row.id,
          baseline: primaryOf(base),
          candidate: primaryOf(next),
          latencyMs: Math.max(left.latencyMs, right.latencyMs),
        };
        return scored;
      },
      onComparison: (comparison) => {
        recorded.push({
          split: comparison.split,
          promptHash: promptHash(comparison.candidatePrompt),
          items: comparison.items,
        });
      },
    });
    bound.workflow = workflow;
    const fingerprint = (await workflow.artifact(readContext())).configurationHash;
    registry.fingerprint = () => fingerprint;
    const controller = new ImprovementController(loop, {
      workflows: [workflow],
      mode: "autonomous",
      selfImproving: true,
      ...(input.timeouts
        ? {
            callbackTimeoutMs: input.timeouts.callbackTimeoutMs,
            tickTimeoutMs: input.timeouts.tickTimeoutMs,
          }
        : {}),
    });
    const transitions: { state: string; reason: string; at?: string; cause?: string }[] = [];
    let result: TickResult | undefined;
    let rollbackCause: string | undefined;
    for (let tick = 0; tick < input.tickLimit; tick++) {
      input.runner.afterPredict?.();
      result = await controller.tick(workflow.id);
      input.runner.afterPredict?.();
      const step = {
        state: result.state,
        reason: result.reason,
        at: clock.now.toISOString(),
        ...(result.cause ? { cause: result.cause } : {}),
      };
      transitions.push(step);
      noteTransition(decisionLog, step);
      if (result.cause) rollbackCause = result.cause;
      if (TERMINAL.has(result.state)) break;
      if (result.state === "observing")
        clock.now = new Date(
          clock.now.getTime() +
            watchStepMs({
              productionRows: input.split.production.length,
              observeChunk: input.observeChunk,
              timeoutMs: policy.observation.timeoutMs,
              minimumDurationMs: policy.observation.minimumDurationMs,
            }),
        );
    }
    if (!result || !TERMINAL.has(result.state))
      throw new Error(
        `Loop did not finish: ${result?.state ?? "none"} (${result?.reason ?? "no tick"}).`,
      );
    const candidateIds = new Map<string, string>();
    for (const id of result.candidateIds) {
      const candidate = await loop.getCandidate(id);
      if (!candidate) continue;
      const text = fragmentOf(candidate.proposedChange);
      const hashed = promptHash(text);
      candidateIds.set(hashed, id);
      noteCandidate(decisionLog, { id, promptHash: hashed, prompt: text }, { recordPromptText: true });
    }
    for (const comparison of recorded) {
      const candidateId = candidateIdFor(comparison.promptHash, [...candidateIds].map(([promptHash, id]) => ({ id, promptHash })));
      appendRound(decisionLog, {
        candidateId,
        promptHash: comparison.promptHash,
        split: comparison.split,
        items: comparison.items,
        minimumImprovement: input.minimumImprovement,
        rule: {
          ...rule,
          minimumDecisive: comparison.split === "audit" ? auditDecisive : validationDecisive,
        },
      });
    }
    if (result.state === "rolled_back") {
      const rolled: string[] = [];
      for (const id of result.candidateIds) {
        const candidate = await loop.getCandidate(id);
        if (candidate?.status !== "rolled_back") continue;
        const hashed = promptHash(fragmentOf(candidate.proposedChange));
        rolled.push(candidateIdFor(hashed, [{ id, promptHash: hashed }]));
      }
      const undone = rolled.length > 0 ? rolled : result.candidateIds;
      noteRolledBack(decisionLog, undone, rollbackCause);
    }
    const settled = settleSeed(decisionLog);
    if (!input.deferServedCheck) {
      if (settled.promptHash !== promptHash(registry.fragment()))
        throw new Error("Served prompt does not match the acceptance log.");
      decisionLog.complete = true;
    }
    decisionLog.served = settled;
    const served = registry.fragment();
    const scored = input.deferHeldOut
      ? { held: draftOf([]), ungated: null as RateDraft | null, servedReused: false, ungatedReused: false }
      : await scoreServedAndUngated(
          input.task,
          input.runner,
          served,
          proposal,
          input.split.heldOut,
          input.baselineHeldOut,
        );
    return {
      fragment: served,
      version: registry.version,
      baselineVersion,
      heldOut: scored.held,
      ungated: scored.ungated,
      servedReused: scored.servedReused,
      ungatedReused: scored.ungatedReused,
      gates: "improvement-controller",
      state: result.state,
      reason: result.reason,
      detail: result.detail ?? null,
      transitions,
      readIds,
      decisions: decisionLog,
      proposedFragment: proposal,
      baselineFeedback: feedback,
    };
  } finally {
    await loop.close();
  }
}

async function scoreServedAndUngated<T extends PublicExample>(
  task: BenchmarkTask<T>,
  runner: ModelRunner<T>,
  served: string,
  proposal: string | null,
  rows: Parameters<typeof scoreHeldOut<T>>[3],
  baseline?: BaselineHeldOut,
): Promise<{ held: RateDraft; ungated: RateDraft | null; servedReused: boolean; ungatedReused: boolean }> {
  const baselineHash = baseline?.promptHash;
  const servedHash = promptHash(served);
  const servedReused = baselineHash !== undefined && servedHash === baselineHash;
  const held =
    servedReused && baseline
      ? baseline.result
      : await scoreHeldOut(task, runner, served, rows, {
          arm: "controller",
          split: "held-out-served",
          planned: rows.length,
        });
  if (!proposal) return { held, ungated: null, servedReused, ungatedReused: false };
  const proposalHash = promptHash(proposal);
  const ungatedReused = baselineHash !== undefined && proposalHash === baselineHash;
  if (ungatedReused && baseline)
    return { held, ungated: baseline.result, servedReused, ungatedReused };
  if (proposalHash === servedHash) return { held, ungated: held, servedReused, ungatedReused: false };
  const ungated = await scoreHeldOut(task, runner, proposal, rows, {
    arm: "controller",
    split: "held-out-ungated",
    planned: rows.length,
  });
  return { held, ungated, servedReused, ungatedReused: false };
}

function emptyFeedback<T extends PublicExample>(rows: readonly T[]): BaselineFeedback {
  return {
    byId: new Map(rows.map((row) => [row.id, []])),
    predictionById: new Map(),
    scoreById: new Map(),
    ids: rows.map((row) => row.id),
  };
}

async function rewrite<T extends PublicExample>(
  task: BenchmarkTask<T>,
  split: PublicSplit<T>,
  runner: ModelRunner<T>,
  mode: "improve" | "harmful",
  context: CallbackContext | null,
): Promise<{ fragment: string; feedback: BaselineFeedback }> {
  const feedback = await feedbackFor(task, split, runner, mode, "one-shot");
  const rows = split.optimization.map((row) => row.example);
  const fragment = assertWithinCap(
    await runner.propose(
      {
        current: task.baselinePrompt,
        rows,
        feedback: rows.map((row) => feedback.byId.get(row.id) ?? []),
        mode,
        exampleSeed: PROPOSE_SELECTION_SEED,
        predictions: rows.map((row) => feedback.predictionById.get(row.id) ?? null),
        scores: rows.map((row) => feedback.scoreById.get(row.id) ?? null),
      },
      context,
    ),
    task.promptCap,
  );
  return { fragment, feedback };
}

async function feedbackFor<T extends PublicExample>(
  task: BenchmarkTask<T>,
  split: PublicSplit<T>,
  runner: ModelRunner<T>,
  mode: "improve" | "harmful",
  arm: PredictCall["arm"],
): Promise<BaselineFeedback> {
  const rows = split.optimization.map((row) => row.example);
  if (!task.feedbackPredicts || mode === "harmful") return emptyFeedback(rows);
  const answers: { response: string; row: T }[] = [];
  for (const row of rows) {
    runner.afterPredict?.();
    const answer = await runner.answer(task.baselinePrompt, row, null, {
      arm,
      split: "feedback",
      planned: rows.length,
    });
    runner.afterPredict?.();
    answers.push({ response: answer.text, row });
  }
  const scores = await task.scoreMany(answers);
  const byId = new Map<string, InstructionMark[]>();
  const predictionById = new Map<string, string>();
  const scoreById = new Map<string, number>();
  rows.forEach((row, index) => {
    const score = scores[index];
    const primary = score ? primaryOf(score) : 0;
    const instructions = score?.instructions ?? [];
    byId.set(
      row.id,
      instructions.length
        ? instructions
        : [{ id: "primary", strict: primary === 1, loose: primary === 1 }],
    );
    predictionById.set(row.id, answers[index]?.response ?? "");
    scoreById.set(row.id, primary);
  });
  return { byId, predictionById, scoreById, ids: rows.map((row) => row.id) };
}

function exampleOf<T extends PublicExample>(pool: Map<string, T>, id: string): T {
  const row = pool.get(id);
  if (!row) throw new Error(`Row ${id} is not in the pool.`);
  return row;
}

export function draftOf(
  scores: readonly RowScore[],
  questions: readonly { id: string; failed: boolean }[] = [],
): RateDraft {
  const trials = scores.length;
  let successes = 0;
  let looseSum = 0;
  let looseCount = 0;
  let f1Sum = 0;
  let f1Count = 0;
  let strictPasses = 0;
  let strictTotal = 0;
  let loosePasses = 0;
  let looseTotal = 0;
  for (const score of scores) {
    const primary = primaryOf(score);
    if (primary !== 0 && primary !== 1)
      throw new Error("Primary benchmark scores are pass or fail.");
    successes += primary;
    if (score.loose !== null) {
      looseSum += score.loose;
      looseCount += 1;
    }
    if (score.f1 !== null) {
      f1Sum += score.f1;
      f1Count += 1;
    }
    strictPasses += score.instructionStrictPasses;
    strictTotal += score.instructionStrictTotal;
    loosePasses += score.instructionLoosePasses;
    looseTotal += score.instructionLooseTotal;
  }
  if (questions.length !== 0 && questions.length !== scores.length)
    throw new Error("Question results do not match the scores.");
  return {
    successes,
    trials,
    rate: trials === 0 ? 0 : successes / trials,
    loose: looseCount === 0 ? null : looseSum / looseCount,
    f1: f1Count === 0 ? null : f1Sum / f1Count,
    instructionStrict: strictTotal === 0 ? null : strictPasses / strictTotal,
    instructionLoose: looseTotal === 0 ? null : loosePasses / looseTotal,
    items: scores.map((score, index) => ({
      id: questions[index]?.id ?? String(index),
      correct: primaryOf(score) === 1,
      failed: questions[index]?.failed === true,
    })),
  };
}

async function runOneShotThenController<T extends PublicExample>(
  input: Parameters<typeof runController<T>>[0],
): Promise<ArmRun> {
  const [shotAudit, restAudit] = splitAuditRows(input.split.audit);
  if (shotAudit.length === 0 || restAudit.length === 0)
    throw new Error("Audit rows must split into two non-empty sets.");
  const fragment = input.oneShotFragment;
  if (!fragment) throw new Error("One-shot fragment is required.");
  const decisionLog = input.decisionLog ?? emptySeedLog(input.split.seed, input.task.baselinePrompt);
  const { oneShotFragment: _fragment, baselineFeedback: supplied, ...rest } = input;
  const baselineFeedback =
    supplied ?? (await feedbackFor(input.task, input.split, input.runner, input.mode, "controller"));
  const seeded = await runController({
    ...rest,
    fixedFragment: fragment,
    auditRows: shotAudit,
    decisionLog,
    baselineFeedback,
    deferServedCheck: true,
    deferHeldOut: true,
    scenario: `${input.scenario}/one-shot-gate`,
  });
  const follow = await runController({
    ...rest,
    initialPrompt: seeded.fragment,
    auditRows: restAudit,
    decisionLog,
    baselineFeedback,
    exampleSeed: FOLLOW_PROPOSE_SEED,
    deferServedCheck: true,
    deferHeldOut: true,
    scenario: `${input.scenario}/follow`,
  });
  const prompts = new Map<string, string>([
    [promptHash(input.task.baselinePrompt), input.task.baselinePrompt],
    [promptHash(seeded.fragment), seeded.fragment],
    [promptHash(follow.fragment), follow.fragment],
  ]);
  const settled = settleSeed(decisionLog);
  const served = prompts.get(settled.promptHash);
  if (!served) throw new Error("Served prompt does not match the acceptance log.");
  decisionLog.served = settled;
  decisionLog.complete = true;
  const kept =
    follow.state === "rolled_back"
      ? "rolled_back"
      : seeded.state === "completed" || follow.state === "completed"
        ? "completed"
        : follow.state;
  const ungatedPrompt = follow.proposedFragment;
  const scored = await scoreServedAndUngated(
    input.task,
    input.runner,
    served,
    ungatedPrompt,
    input.split.heldOut,
    input.baselineHeldOut,
  );
  return {
    ...follow,
    fragment: served,
    version: hash({ fragment: served }),
    baselineVersion: seeded.baselineVersion,
    heldOut: scored.held,
    ungated: scored.ungated,
    servedReused: scored.servedReused,
    ungatedReused: scored.ungatedReused,
    state: kept,
    reason: kept === "completed" && follow.state !== "completed" ? seeded.reason : follow.reason,
    transitions: [...seeded.transitions, ...follow.transitions],
    readIds: [...seeded.readIds, ...follow.readIds],
    decisions: decisionLog,
    proposedFragment: ungatedPrompt,
    baselineFeedback,
  };
}

export function candidateIdFor(
  hashed: string,
  known: readonly { id: string; promptHash: string }[],
): string {
  return known.find((row) => row.promptHash === hashed)?.id ?? `prompt:${hashed.slice(0, 12)}`;
}

export function leakedIds(readIds: readonly string[], heldOutIds: readonly string[]): string[] {
  const held = new Set(heldOutIds);
  return [...new Set(readIds.filter((id) => held.has(id)))];
}
