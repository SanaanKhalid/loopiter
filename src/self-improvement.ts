import type {
  AdaptationCandidate,
  AnalyzeOptions,
  CandidateEvaluator,
  CandidateRisk,
  CandidateTarget,
  CandidateTargetKind,
  DeploymentAdapter,
  EvaluationResult,
  Finding,
  JsonObject,
  JsonValue,
} from "./contracts.js";
import { targetKinds, risks } from "./contracts.js";
import type { FeedbackLoop } from "./feedback-loop.js";
import {
  cancellable,
  enumeration,
  fail,
  finite,
  hash,
  integer,
  nonempty,
} from "./utils.js";
import { evaluation } from "./validation.js";
export type AutonomyLevel = "observe" | "recommend" | "experiment";
export interface EvaluationConstraint {
  metric: string;
  comparator: "gte" | "lte" | "gt" | "lt" | "eq";
  value: number;
}
export interface ImprovementPolicy {
  autonomy?: AutonomyLevel;
  allowedTargets: CandidateTargetKind[];
  maximumCandidatesPerRun?: number;
  maximumProposalCalls?: number;
  runTimeoutMs?: number;
  callbackTimeoutMs?: number;
  constraints?: EvaluationConstraint[];
}
export interface ImprovementProposal {
  target: CandidateTarget;
  proposedChange: JsonValue;
  risk: CandidateRisk;
  metadata?: JsonObject;
}
export interface ImprovementRecipe {
  name: string;
  version: string;
  matches(
    finding: Finding,
    context: { signal: AbortSignal },
  ): boolean | Promise<boolean>;
  propose(
    finding: Finding,
    context: { signal: AbortSignal },
  ):
    | ImprovementProposal
    | ImprovementProposal[]
    | undefined
    | Promise<ImprovementProposal | ImprovementProposal[] | undefined>;
}
export interface SelfImprovementRunInput {
  analysis: AnalyzeOptions;
  policy: ImprovementPolicy;
  recipes: ImprovementRecipe[];
  evaluator?: CandidateEvaluator;
  evaluation?: { name: string; version: string; datasetHash: string };
  deploymentAdapter?: DeploymentAdapter;
  signal?: AbortSignal;
}
export interface ImprovementBlock {
  reason: string;
  candidateId?: string;
  detail?: string;
}
export interface SelfImprovementRunResult {
  autonomy: AutonomyLevel;
  findings: Finding[];
  candidates: AdaptationCandidate[];
  deployed: string[];
  blocked: ImprovementBlock[];
  proposalCalls: number;
}
export function applyConstraints(
  result: EvaluationResult,
  constraints: EvaluationConstraint[],
): EvaluationResult {
  evaluation(result);
  for (const c of constraints) {
    const number = result.metrics?.[c.metric];
    const passed =
      number !== undefined &&
      Number.isFinite(number) &&
      {
        gte: () => number >= c.value,
        lte: () => number <= c.value,
        gt: () => number > c.value,
        lt: () => number < c.value,
        eq: () => number === c.value,
      }[c.comparator]();
    if (!passed)
      return {
        ...result,
        passed: false,
        notes: `Constraint failed: ${c.metric} ${c.comparator} ${c.value}`,
      };
  }
  return result;
}
/** @deprecated Use ImprovementController for durable, baseline-bound cycles. Reviewed modes only. */
export class SelfImprovementController {
  constructor(readonly loop: FeedbackLoop) {}
  async run(input: SelfImprovementRunInput): Promise<SelfImprovementRunResult> {
    if ((input.policy as {autonomy?:unknown}).autonomy === "apply" || "experimentalAutoApply" in input.policy)
      fail("migration_required", "Legacy auto-apply is removed. Use ImprovementController with selfImproving and a complete autonomy policy.");
    const autonomy = input.policy.autonomy ?? "recommend";
    enumeration(
      autonomy,
      ["observe", "recommend", "experiment"],
      "autonomy",
    );
    if (!Array.isArray(input.policy.allowedTargets))
      fail("invalid_input", "allowedTargets is required.");
    for (const kind of input.policy.allowedTargets)
      enumeration(kind, targetKinds, "allowed target");
    for (const c of input.policy.constraints ?? []) {
      nonempty(c.metric, "metric");
      finite(c.value, "constraint value");
      enumeration(c.comparator, ["gte", "lte", "gt", "lt", "eq"], "comparator");
    }
    const maxCandidates = input.policy.maximumCandidatesPerRun ?? 3,
      maxCalls = input.policy.maximumProposalCalls ?? 3;
    const callbackMs = input.policy.callbackTimeoutMs ?? 120000,
      runMs = input.policy.runTimeoutMs ?? 600000;
    integer(maxCandidates, "maximumCandidatesPerRun");
    integer(maxCalls, "maximumProposalCalls");
    integer(callbackMs, "callbackTimeoutMs");
    integer(runMs, "runTimeoutMs");
    for (const recipe of input.recipes) {
      nonempty(recipe.name, "recipe name");
      nonempty(recipe.version, "recipe version");
    }
    if (autonomy === "experiment") {
      if (!input.evaluator || !input.evaluation)
        fail(
          "invalid_input",
          "Versioned evaluator and datasetHash are required.",
        );
      nonempty(input.evaluation.name, "evaluator name");
      nonempty(input.evaluation.version, "evaluator version");
      nonempty(input.evaluation.datasetHash, "datasetHash");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Run deadline exceeded.")),
      runMs,
    );
    const result: SelfImprovementRunResult = {
      autonomy,
      findings: [],
      candidates: [],
      deployed: [],
      blocked: [],
      proposalCalls: 0,
    };
    try {
      controller.signal.throwIfAborted();
      result.findings = await this.loop.analyze(input.analysis);
      controller.signal.throwIfAborted();
      if (autonomy === "observe") return result;
      outer: for (const finding of result.findings)
        for (const recipe of input.recipes) {
          if (
            result.proposalCalls >= maxCalls ||
            result.candidates.length >= maxCandidates
          ) {
            result.blocked.push({ reason: "run_budget_reached" });
            break outer;
          }
          const matches = await cancellable(
            (signal) => recipe.matches(finding, { signal }),
            controller.signal,
            callbackMs,
          );
          if (typeof matches !== "boolean")
            fail("invalid_input", "Recipe matches must return boolean.");
          if (!matches) continue;
          result.proposalCalls++;
          const output = await cancellable(
            (signal) => recipe.propose(finding, { signal }),
            controller.signal,
            callbackMs,
          );
          for (const proposal of output === undefined
            ? []
            : Array.isArray(output)
              ? output
              : [output]) {
            controller.signal.throwIfAborted();
            if (result.candidates.length >= maxCandidates) break outer;
            enumeration(proposal.risk, risks, "proposal risk");
            enumeration(proposal.target?.kind, targetKinds, "proposal target");
            if (!input.policy.allowedTargets.includes(proposal.target.kind)) {
              result.blocked.push({ reason: "target_not_allowed" });
              continue;
            }
            const candidateId = `candidate_${hash({ namespace: this.loop.namespace, evidence: finding.evidence.fingerprint, recipe: [recipe.name, recipe.version], proposal, evaluation: input.evaluation ?? null })}`;
            let candidate = await this.loop.createCandidate({
              id: candidateId,
              ...proposal,
              evidence: finding.evidence as unknown as JsonValue,
            });
            result.candidates.push(candidate);
            if (autonomy === "recommend") continue;
            if (!["proposed", "evaluated"].includes(candidate.status)) {
              result.blocked.push({
                reason: "candidate_requires_explicit_action",
                candidateId,
              });
              continue;
            }
            try {
              candidate = await this.loop.evaluateCandidate(
                candidate.id,
                {
                  evaluator: input.evaluation!.name,
                  version: input.evaluation!.version,
                  datasetHash: input.evaluation!.datasetHash,
                  signal: controller.signal,
                },
                (item, context) =>
                  cancellable(
                    async (signal) =>
                      applyConstraints(
                        await input.evaluator!(item, { signal }),
                        input.policy.constraints ?? [],
                      ),
                    context.signal,
                    callbackMs,
                  ),
              );
              result.candidates[result.candidates.length - 1] = candidate;
              if (!candidate.evaluations.at(-1)?.passed) {
                result.blocked.push({
                  reason: "evaluation_failed",
                  candidateId,
                });
                continue;
              }
            } catch (error) {
              result.blocked.push({
                reason: "operation_failed",
                candidateId,
                detail: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
    } catch (error) {
      result.blocked.push({
        reason: controller.signal.aborted ? "run_cancelled" : "run_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
    return result;
  }
}
