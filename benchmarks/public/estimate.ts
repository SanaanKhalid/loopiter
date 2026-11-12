/**
 * Call plan for the three arms. No provider call is made.
 * Token sizes repeat a checked-in fixture row; they are not measured on the download.
 */
import {
  PACE_HEADROOM,
  readEstimatePrices,
  type LivePrices,
  type RequestLimits,
} from "../kb-qa/live.js";
import { formatArm, planCall, requestBody, type PlannedCall } from "./bodies.js";
import { FOLLOW_MARKER, FULL_SEEDS, appendMarker } from "./constants.js";
import { PROPOSE_INSTRUCTIONS, PROPOSE_NAME, PREDICT_NAME } from "./instructions.js";
import { deploymentOf, readMaxTpm, resolveLimits } from "./limits.js";
import type { SplitSizes } from "./splits.js";
import type { BenchmarkTask, InstructionMark, PublicExample } from "./task.js";

export interface ArmPlan {
  label: "smoke" | "full";
  seeds: number[];
  sizes: SplitSizes;
  arms: Record<"baseline" | "one-shot" | "controller", PlannedCall[]>;
}

export function planTask<T extends PublicExample>(
  task: BenchmarkTask<T>,
  input: {
    label: ArmPlan["label"];
    seeds: readonly number[];
    sizes: SplitSizes;
    limits: RequestLimits;
    deployment: string;
  },
): ArmPlan {
  const sample = task.fixtures().pool[0];
  if (!sample) throw new Error(`${task.title} has no fixture row.`);
  const standIn = appendMarker(task.baselinePrompt, FOLLOW_MARKER, task.promptCap);
  const predictBaseline = requestBody({
    model: input.deployment,
    instructions: task.baselinePrompt,
    payload: task.predictPayload(sample),
    name: PREDICT_NAME,
    schema: task.predictSchema(),
    maxOutputTokens: input.limits.predictMaxOutputTokens,
    reasoningEffort: input.limits.reasoningEffort,
  });
  const predictCandidate = requestBody({
    model: input.deployment,
    instructions: standIn,
    payload: task.predictPayload(sample),
    name: PREDICT_NAME,
    schema: task.predictSchema(),
    maxOutputTokens: input.limits.predictMaxOutputTokens,
    reasoningEffort: input.limits.reasoningEffort,
  });
  const proposeRows = Array.from({ length: input.sizes.optimization }, () => sample);
  const feedback: InstructionMark[][] = task.feedbackPredicts
    ? proposeRows.map(() => [{ id: "example", strict: false, loose: false }])
    : proposeRows.map(() => []);
  const propose = requestBody({
    model: input.deployment,
    instructions: PROPOSE_INSTRUCTIONS,
    payload: task.proposePayload(task.baselinePrompt, proposeRows, feedback),
    name: PROPOSE_NAME,
    schema: task.proposeSchema(),
    maxOutputTokens: input.limits.proposeMaxOutputTokens,
    reasoningEffort: input.limits.reasoningEffort,
  });
  const arms = {
    baseline: [] as PlannedCall[],
    "one-shot": [] as PlannedCall[],
    controller: [] as PlannedCall[],
  };
  for (const seed of input.seeds) {
    pushPredict(arms.baseline, "baseline", "held-out", seed, input.sizes.heldOut, predictBaseline, input.limits.predictMaxOutputTokens);
    if (task.feedbackPredicts)
      pushPredict(arms["one-shot"], "one-shot", "feedback", seed, input.sizes.optimization, predictBaseline, input.limits.predictMaxOutputTokens);
    arms["one-shot"].push(planCall("one-shot", "propose", "propose", seed, propose, input.limits.proposeMaxOutputTokens));
    pushPredict(arms["one-shot"], "one-shot", "held-out", seed, input.sizes.heldOut, predictCandidate, input.limits.predictMaxOutputTokens);
    if (task.feedbackPredicts)
      pushPredict(arms.controller, "controller", "feedback", seed, input.sizes.optimization, predictBaseline, input.limits.predictMaxOutputTokens);
    arms.controller.push(planCall("controller", "propose", "propose", seed, propose, input.limits.proposeMaxOutputTokens));
    pushPredict(arms.controller, "controller", "validation", seed, input.sizes.validation, predictBaseline, input.limits.predictMaxOutputTokens);
    pushPredict(arms.controller, "controller", "validation", seed, input.sizes.validation, predictCandidate, input.limits.predictMaxOutputTokens);
    pushPredict(arms.controller, "controller", "audit", seed, input.sizes.audit, predictBaseline, input.limits.predictMaxOutputTokens);
    pushPredict(arms.controller, "controller", "audit", seed, input.sizes.audit, predictCandidate, input.limits.predictMaxOutputTokens);
    pushPredict(arms.controller, "controller", "production", seed, input.sizes.production, predictCandidate, input.limits.predictMaxOutputTokens);
    pushPredict(arms.controller, "controller", "held-out-served", seed, input.sizes.heldOut, predictCandidate, input.limits.predictMaxOutputTokens);
    pushPredict(arms.controller, "controller", "held-out-ungated", seed, input.sizes.heldOut, predictCandidate, input.limits.predictMaxOutputTokens);
  }
  return { label: input.label, seeds: [...input.seeds], sizes: input.sizes, arms };
}

export function renderTaskEstimate<T extends PublicExample>(
  task: BenchmarkTask<T>,
  env: NodeJS.ProcessEnv,
): string {
  const { limits, deployment, apiVersion, prices, maxTokensPerMinute } = estimateContext(task, env);
  const smoke = planTask(task, {
    label: "smoke",
    seeds: [1],
    sizes: smokeSizes(task.smokeRows),
    limits,
    deployment,
  });
  const full = planTask(task, {
    label: "full",
    seeds: [...FULL_SEEDS],
    sizes: task.fullSizes,
    limits,
    deployment,
  });
  return [
    `${task.title} live estimate`,
    "No provider calls were made.",
    "Results of a later run are internal.",
    `Dataset: ${task.id}`,
    `Deployment: ${deployment}`,
    `API: Azure OpenAI Responses (api-version ${apiVersion})`,
    `Input price USD per 1M tokens: ${prices.inputUsdPerMillion}`,
    `Output price USD per 1M tokens: ${prices.outputUsdPerMillion}`,
    `Predict max output tokens: ${limits.predictMaxOutputTokens}`,
    `Propose max output tokens: ${limits.proposeMaxOutputTokens}`,
    `Reasoning effort: ${limits.reasoningEffort ?? "omitted"}`,
    "Arms: frozen baseline, one-shot rewrite with no gates, and the autonomous ImprovementController.",
    "Input tokens repeat one checked-in fixture row up to the split size. Output tokens are the max_output_tokens bound. This is a call plan, not a measured score.",
    `Projection rounds each call to micro-USD. TPM pacing reserves bytes/4 plus the output bound against ${Math.round(PACE_HEADROOM * 100)}% of LOOPITER_BENCH_MAX_TPM.`,
    "",
    formatPlan(smoke, prices, maxTokensPerMinute),
    "",
    formatPlan(full, prices, maxTokensPerMinute),
    "",
  ].join("\n");
}

function estimateContext<T extends PublicExample>(task: BenchmarkTask<T>, env: NodeJS.ProcessEnv) {
  const limits = resolveLimits(env, task);
  const { deployment, apiVersion } = deploymentOf(env);
  const quoted = readEstimatePrices(env);
  const prices: LivePrices = {
    inputUsdPerMillion: quoted.inputUsdPerMillion,
    outputUsdPerMillion: quoted.outputUsdPerMillion,
    cachedInputUsdPerMillion: quoted.inputUsdPerMillion,
  };
  return { limits, deployment, apiVersion, prices, maxTokensPerMinute: readMaxTpm(env) };
}

function smokeSizes(rows: number): SplitSizes {
  return {
    optimization: rows,
    validation: rows,
    audit: rows,
    production: rows,
    heldOut: rows,
  };
}

function pushPredict(
  calls: PlannedCall[],
  arm: PlannedCall["arm"],
  stage: string,
  seed: number,
  count: number,
  body: string,
  outputTokens: number,
): void {
  for (let index = 0; index < count; index++)
    calls.push(planCall(arm, "predict", stage, seed, body, outputTokens));
}

function formatPlan(plan: ArmPlan, prices: LivePrices, maxTokensPerMinute: number): string {
  const sizes = `optimization ${plan.sizes.optimization}, validation ${plan.sizes.validation}, audit ${plan.sizes.audit}, production ${plan.sizes.production}, held-out ${plan.sizes.heldOut}`;
  return [
    plan.label,
    `seeds: ${plan.seeds.join(", ")}`,
    `rows per split: ${sizes}`,
    formatArm("baseline", plan.arms.baseline, prices, maxTokensPerMinute),
    formatArm("one-shot", plan.arms["one-shot"], prices, maxTokensPerMinute),
    formatArm("controller", plan.arms.controller, prices, maxTokensPerMinute),
  ].join("\n");
}
