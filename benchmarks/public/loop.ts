/**
 * One-shot arm and the autonomous controller. Held-out rows are scored only
 * after those arms return, and only through the held-out type.
 */
import {
  FeedbackLoop,
  ImprovementController,
  InMemoryStore,
  type CallbackContext,
  type DatasetRow,
  type TickResult,
} from "../../src/index.js";
import { longestExample, sizedReservations } from "./budget.js";
import {
  CLOCK_START,
  assertWithinCap,
} from "./constants.js";
import { promptPolicy } from "./policy.js";
import { mockRewrite } from "./propose.js";
import { PromptRegistry, fragmentOf } from "./registry.js";
import {
  idsOf,
  poolDatasetRow,
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

export interface RateDraft {
  successes: number;
  trials: number;
  rate: number;
  loose: number | null;
  f1: number | null;
  instructionStrict: number | null;
  instructionLoose: number | null;
}

export interface ArmRun {
  fragment: string;
  version: string;
  baselineVersion: string;
  heldOut: RateDraft;
  ungated: RateDraft | null;
  gates: "none" | "improvement-controller";
  state: string;
  reason: string;
  transitions: { state: string; reason: string }[];
  readIds: string[];
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
    answers.push({ response: answer.text, row: row.example });
  }
  runner.afterPredict?.();
  return draftOf(await task.scoreMany(answers));
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
  const { fragment, ids } = await rewrite(input.task, input.split, input.runner, input.mode, null);
  for (const id of ids) readIds.push(id);
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
    gates: "none",
    state: "applied",
    reason: "ungated",
    transitions: [],
    readIds,
  };
}

export async function runController<T extends PublicExample>(input: {
  task: BenchmarkTask<T>;
  split: PublicSplit<T>;
  runner: ModelRunner<T>;
  mode: "improve" | "harmful";
  observation: "honest" | "fail";
  minimumImprovement: number;
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
  const feedback = await feedbackFor(input.task, input.split, input.runner, input.mode, "controller");
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
  const registry = new PromptRegistry(input.task.baselinePrompt);
  const baselineVersion = registry.version;
  let proposal: string | null = null;
  let observeCursor = 0;
  let observeWrong = 0;
  let observeScored = 0;
  try {
    const sizes = {
      optimization: input.split.optimization.length,
      validation: input.split.validation.length,
      audit: input.split.audit.length,
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
    const policy = promptPolicy({
      taskId: input.task.id,
      promptCap: input.task.promptCap,
      minimumImprovement: input.minimumImprovement,
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
        const audit = input.split.audit.map(datasetRow);
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
        watch(examples);
        const rows = examples.map((row) => exampleOf(pool, row.id));
        const marks = rows.map((row) => {
          const found = feedback.byId.get(row.id);
          if (!found) throw new Error(`Propose is missing feedback for ${row.id}.`);
          return found;
        });
        const fragment = assertWithinCap(
          await input.runner.propose(
            { current: input.task.baselinePrompt, rows, feedback: marks, mode: input.mode },
            context,
          ),
          input.task.promptCap,
        );
        proposal = fragment;
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
    const transitions: { state: string; reason: string }[] = [];
    let result: TickResult | undefined;
    for (let tick = 0; tick < input.tickLimit; tick++) {
      input.runner.afterPredict?.();
      result = await controller.tick(workflow.id);
      input.runner.afterPredict?.();
      transitions.push({ state: result.state, reason: result.reason });
      if (TERMINAL.has(result.state)) break;
      if (result.state === "observing")
        clock.now = new Date(clock.now.getTime() + 7_200_000);
    }
    if (!result || !TERMINAL.has(result.state))
      throw new Error(
        `Loop did not finish: ${result?.state ?? "none"} (${result?.reason ?? "no tick"}).`,
      );
    const served = registry.fragment();
    const held = await scoreHeldOut(input.task, input.runner, served, input.split.heldOut, {
      arm: "controller",
      split: "held-out-served",
      planned: input.split.heldOut.length,
    });
    const ungated = proposal
      ? await scoreHeldOut(input.task, input.runner, proposal, input.split.heldOut, {
          arm: "controller",
          split: "held-out-ungated",
          planned: input.split.heldOut.length,
        })
      : null;
    return {
      fragment: served,
      version: registry.version,
      baselineVersion,
      heldOut: held,
      ungated,
      gates: "improvement-controller",
      state: result.state,
      reason: result.reason,
      transitions,
      readIds,
    };
  } finally {
    await loop.close();
  }
}

async function rewrite<T extends PublicExample>(
  task: BenchmarkTask<T>,
  split: PublicSplit<T>,
  runner: ModelRunner<T>,
  mode: "improve" | "harmful",
  context: CallbackContext | null,
): Promise<{ fragment: string; ids: string[] }> {
  const feedback = await feedbackFor(task, split, runner, mode, "one-shot");
  const rows = split.optimization.map((row) => row.example);
  const fragment = assertWithinCap(
    await runner.propose(
      {
        current: task.baselinePrompt,
        rows,
        feedback: rows.map((row) => feedback.byId.get(row.id) ?? []),
        mode,
      },
      context,
    ),
    task.promptCap,
  );
  return { fragment, ids: feedback.ids };
}

async function feedbackFor<T extends PublicExample>(
  task: BenchmarkTask<T>,
  split: PublicSplit<T>,
  runner: ModelRunner<T>,
  mode: "improve" | "harmful",
  arm: PredictCall["arm"],
): Promise<{ byId: Map<string, InstructionMark[]>; ids: string[] }> {
  const rows = split.optimization.map((row) => row.example);
  const ids = rows.map((row) => row.id);
  if (!task.feedbackPredicts || mode === "harmful") {
    return { byId: new Map(rows.map((row) => [row.id, []])), ids };
  }
  const answers = [];
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
  rows.forEach((row, index) => {
    byId.set(row.id, scores[index]?.instructions ?? []);
  });
  return { byId, ids };
}

function exampleOf<T extends PublicExample>(pool: Map<string, T>, id: string): T {
  const row = pool.get(id);
  if (!row) throw new Error(`Row ${id} is not in the pool.`);
  return row;
}

export function draftOf(scores: readonly RowScore[]): RateDraft {
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
  return {
    successes,
    trials,
    rate: trials === 0 ? 0 : successes / trials,
    loose: looseCount === 0 ? null : looseSum / looseCount,
    f1: f1Count === 0 ? null : f1Sum / f1Count,
    instructionStrict: strictTotal === 0 ? null : strictPasses / strictTotal,
    instructionLoose: looseTotal === 0 ? null : loosePasses / looseTotal,
  };
}

export function leakedIds(readIds: readonly string[], heldOutIds: readonly string[]): string[] {
  const held = new Set(heldOutIds);
  return [...new Set(readIds.filter((id) => held.has(id)))];
}
