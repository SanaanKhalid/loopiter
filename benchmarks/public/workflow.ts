import type {
  CallbackContext,
  Comparison,
  DatasetSnapshot,
  ImprovementWorkflow,
  JsonValue,
} from "../../src/index.js";
import type { AutonomyPolicy } from "../../src/index.js";
import { hash } from "../../src/utils.js";
import { assertWithinCap } from "./constants.js";
import { fragmentOf, type PromptRegistry } from "./registry.js";
import type { RowScore } from "./task.js";

const TERMINAL = new Set([
  "completed",
  "no_improvement",
  "rolled_back",
  "waiting_for_evidence",
  "failed",
  "paused",
  "reconciliation_required",
]);

export { TERMINAL };

export interface BatchCase {
  id: string;
  baseline: number;
  candidate: number;
  latencyMs: number;
}

export function readContext(): CallbackContext {
  return {
    operationId: "benchmark-read",
    signal: new AbortController().signal,
    meter: async () => {
      throw new Error("Benchmark artifact reads do not call a model.");
    },
  };
}

export function createPromptWorkflow(input: {
  id: string;
  version: string;
  policy: AutonomyPolicy;
  registry: PromptRegistry;
  modelId: string;
  promptVersion: string;
  promptCap: number;
  batchSize: number;
  dataset: (context: CallbackContext) => Promise<DatasetSnapshot>;
  observe: ImprovementWorkflow["observe"];
  propose: (
    examples: { id: string }[],
    context: CallbackContext,
  ) => Promise<string>;
  scorePair: (
    row: { id: string },
    baseline: string,
    candidate: string,
    context: CallbackContext,
  ) => Promise<BatchCase>;
}): ImprovementWorkflow {
  const configuration = {
    model: input.modelId,
    task: input.id,
    promptVersion: input.promptVersion,
    safety: "Only the versioned system prompt is editable.",
  };
  const workflow: ImprovementWorkflow = {
    id: input.id,
    version: input.version,
    optimizerVersion: "public-prompt-v1",
    evaluatorVersion: "paired-primary-v1",
    policy: input.policy,
    dataset: input.dataset,
    deployment: input.registry,
    observe: input.observe,
    evaluationBatchSize: input.batchSize,
    artifact: async () => {
      const current = await input.registry.current();
      const configurationHash = hash(configuration);
      return {
        artifactVersion: current.version,
        configurationHash,
      };
    },
    propose: async (proposal, context) => {
      const fragment = assertWithinCap(
        await input.propose(proposal.examples, context),
        input.promptCap,
      );
      return [{ fragment }];
    },
    evaluateBatch: async (batch, context) => {
      const baseline = fragmentOf(await input.registry.get(batch.baseline.artifactVersion));
      const candidate = fragmentOf(batch.change);
      const cases: BatchCase[] = [];
      for (const row of batch.examples)
        cases.push(await input.scorePair(row, baseline, candidate, context));
      return cases as unknown as JsonValue;
    },
    evaluate: async (evaluation): Promise<Comparison> => {
      const cases = flattenCases(evaluation.batchResults);
      if (cases.length !== evaluation.examples.length)
        throw new Error("Evaluation batches did not cover every row.");
      const accuracy =
        cases.length === 0
          ? 0
          : cases.reduce((sum, item) => sum + item.candidate, 0) / cases.length;
      const latencyMs = cases.reduce((max, item) => Math.max(max, item.latencyMs), 0);
      return {
        cases: cases.map((item) => ({
          id: item.id,
          baseline: item.baseline,
          candidate: item.candidate,
        })),
        metrics: {
          accuracy,
          errors: cases.length === 0 ? 1 : 1 - accuracy,
          latencyMs,
          cost: 0,
        },
        estimatedServingCost: 0,
      };
    },
  };
  return workflow;
}

export function flattenCases(value: JsonValue[] | undefined): BatchCase[] {
  const cases: BatchCase[] = [];
  for (const batch of value ?? []) {
    if (!Array.isArray(batch)) throw new Error("Evaluation batch was not a list.");
    for (const item of batch) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("Evaluation case was not an object.");
      const id = item.id;
      const baseline = item.baseline;
      const candidate = item.candidate;
      const latencyMs = item.latencyMs;
      if (typeof id !== "string" || typeof baseline !== "number" || typeof candidate !== "number")
        throw new Error("Evaluation case is missing scores.");
      cases.push({
        id,
        baseline,
        candidate,
        latencyMs: typeof latencyMs === "number" ? latencyMs : 1,
      });
    }
  }
  return cases;
}

export function primaryOf(score: RowScore): number {
  if (!Number.isFinite(score.primary) || score.primary < 0 || score.primary > 1)
    throw new Error("Primary score must be between 0 and 1.");
  return score.primary;
}
