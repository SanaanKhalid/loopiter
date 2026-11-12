import type { AutonomyPolicy } from "../../src/index.js";
import { TRUSTED_SOURCE } from "./constants.js";
import type { SplitSizes } from "./splits.js";

export function promptPolicy(input: {
  taskId: string;
  promptCap: number;
  minimumImprovement: number;
  sizes: SplitSizes;
  latencyMs: number;
}): AutonomyPolicy {
  const loopCalls =
    1 +
    input.sizes.validation * 2 +
    input.sizes.audit * 2 +
    input.sizes.production;
  const reserve = Math.max(input.sizes.validation, input.sizes.audit, 1) * 2 + 10;
  return {
    version: `public-${input.taskId}-v1`,
    target: { kind: "prompt", key: input.taskId },
    changeSchema: {
      type: "object",
      properties: {
        fragment: { type: "string", maxLength: input.promptCap },
      },
      required: ["fragment"],
      additionalProperties: false,
    },
    objective: {
      metric: "accuracy",
      direction: "maximize",
      minimumImprovement: input.minimumImprovement,
      range: [0, 1],
      alpha: 0.05,
    },
    guardrails: [
      { metric: "accuracy", comparator: "gte", value: 0 },
      { metric: "latencyMs", comparator: "lte", value: input.latencyMs },
    ],
    trustedSources: [TRUSTED_SOURCE],
    minimumNewUnits: input.sizes.optimization,
    minimumValidationUnits: input.sizes.validation,
    minimumAuditUnits: input.sizes.audit,
    outcomeMaturityMs: 3_600_000,
    maximumRows: Math.max(input.sizes.audit, input.sizes.validation, input.sizes.optimization),
    daily: {
      modelRequests: loopCalls * 4,
      tokens: loopCalls * 4 * 200,
      deployments: 2,
    },
    callbackReservation: {
      modelRequests: reserve,
      tokens: reserve * 200,
    },
    cooldownMs: 0,
    rollout: { mode: "immediate" },
    observation: {
      minimumDurationMs: 3_600_000,
      timeoutMs: 86_400_000,
      minimumUnits: input.sizes.production,
      guardrails: [{ metric: "errors", comparator: "lte", value: 0.85 }],
      onTimeout: "rollback",
      onFailure: "rollback",
    },
    onInsufficientEvidence: "wait",
    onUncertainDeployment: "reconcile",
    maximumCandidates: 1,
    maximumProposalCalls: 1,
    maximumConsecutiveFailures: 3,
  };
}
