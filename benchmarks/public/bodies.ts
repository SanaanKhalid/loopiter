/**
 * Request bodies shared by --estimate and the live runner.
 * Output tokens are the max_output_tokens bound, matching kb-qa.
 */
import type { JsonObject } from "../../src/index.js";
import { responsesRequestBody } from "../../examples/prompt-improvement/provider.js";
import {
  inputTokenCeiling,
  liveCostMicroUsd,
  projectedInputTokens,
  type LivePrices,
} from "../kb-qa/live.js";
import { formatUsd } from "../kb-qa/money.js";
import { pacedTokenLimit, projectedWallMs } from "../kb-qa/live.js";

export interface PlannedCall {
  arm: "baseline" | "one-shot" | "controller";
  kind: "predict" | "propose";
  stage: string;
  seed: number;
  inputTokens: number;
  outputTokens: number;
  ceilingInputTokens: number;
}

export function requestBody(input: {
  model: string;
  instructions: string;
  payload: string;
  name: string;
  schema: JsonObject;
  maxOutputTokens: number;
  reasoningEffort: string | null;
}): string {
  return JSON.stringify(
    responsesRequestBody({
      model: input.model,
      instructions: input.instructions,
      input: input.payload,
      name: input.name,
      schema: input.schema,
      maxOutputTokens: input.maxOutputTokens,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    }),
  );
}

export function planCall(
  arm: PlannedCall["arm"],
  kind: PlannedCall["kind"],
  stage: string,
  seed: number,
  body: string,
  outputTokens: number,
): PlannedCall {
  return {
    arm,
    kind,
    seed,
    stage,
    inputTokens: projectedInputTokens(body),
    outputTokens,
    ceilingInputTokens: inputTokenCeiling(body),
  };
}

export function armCost(
  calls: readonly PlannedCall[],
  prices: LivePrices,
): { projected: number; ceiling: number; inputTokens: number; outputTokens: number } {
  let projected = 0;
  let ceiling = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const call of calls) {
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    projected += liveCostMicroUsd(
      { input: call.inputTokens, output: call.outputTokens, cached: 0 },
      prices,
    );
    ceiling += Math.ceil(
      call.ceilingInputTokens *
        Math.max(prices.inputUsdPerMillion, prices.cachedInputUsdPerMillion) +
        call.outputTokens * prices.outputUsdPerMillion,
    );
  }
  return { projected, ceiling, inputTokens, outputTokens };
}

export function formatArm(
  name: string,
  calls: readonly PlannedCall[],
  prices: LivePrices,
  maxTokensPerMinute: number,
): string {
  const cost = armCost(calls, prices);
  const limit = pacedTokenLimit(maxTokensPerMinute);
  const wall =
    limit <= 0 ? "pacing off" : (projectedWallMs(calls, limit) / 60_000).toFixed(2);
  return [
    name,
    `calls: ${calls.length}`,
    `predict calls: ${calls.filter((call) => call.kind === "predict").length}`,
    `propose calls: ${calls.filter((call) => call.kind === "propose").length}`,
    `input tokens: ${cost.inputTokens}`,
    `output tokens: ${cost.outputTokens}`,
    `projected USD: ${formatUsd(cost.projected)}`,
    `ceiling USD: ${formatUsd(cost.ceiling)}`,
    `projected wall minutes: ${wall}`,
  ].join("\n");
}
