import type {
  ArtifactBaseline,
  CandidateTarget,
  DeploymentAdapter,
  JsonValue,
  JsonObject,
  RecordBase,
} from "./contracts.js";

export type ImprovementMode =
  | "observe"
  | "recommend"
  | "experiment"
  | "autonomous";
export type RunState =
  | "waiting_for_evidence"
  | "proposing"
  | "evaluating"
  | "selected"
  | "deploying"
  | "observing"
  | "completed"
  | "no_improvement"
  | "paused"
  | "failed"
  | "reconciliation_required"
  | "rolling_back"
  | "rolled_back";
/** Deliberately bounded JSON-schema subset; unknown schema keywords fail closed. */
export interface ChangeSchema {
  type: "object" | "string" | "number" | "boolean";
  properties?: Record<string, ChangeSchema>;
  required?: string[];
  additionalProperties?: false;
  enum?: JsonValue[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}
export interface MetricGate {
  metric: string;
  comparator: "gte" | "lte";
  value: number;
}
export interface AutonomyPolicy {
  version: string;
  target: CandidateTarget;
  changeSchema: ChangeSchema;
  objective: {
    metric: string;
    direction: "maximize" | "minimize";
    minimumImprovement: number;
    range: [number, number];
    alpha: number;
  };
  guardrails: MetricGate[];
  trustedSources: string[];
  minimumNewUnits: number;
  minimumValidationUnits: number;
  minimumAuditUnits: number;
  outcomeMaturityMs: number;
  maximumRows: number;
  daily: { modelRequests: number; tokens: number; deployments: number };
  callbackReservation: { modelRequests: number; tokens: number };
  cooldownMs: number;
  rollout: { mode: "immediate" | "canary" };
  observation: {
    minimumDurationMs: number;
    timeoutMs: number;
    minimumUnits: number;
    guardrails: MetricGate[];
    onTimeout: "rollback";
    onFailure: "rollback";
  };
  onInsufficientEvidence: "wait";
  onUncertainDeployment: "reconcile";
  maximumCandidates?: number;
  maximumProposalCalls?: number;
  /** Stop proposing after this many consecutive failed cycles. Resume is administrative. */
  maximumConsecutiveFailures?: number;
  /** Optional trusted application statistical method; absent uses paired Hoeffding. */
  auditMethod?: { name: string; version: string };
}
export interface DatasetRow {
  id: string;
  episodeId: string;
  entityId: string;
  occurredAt: string;
  observedAt: string;
  source: string;
  input: JsonValue;
  label: JsonValue;
}
export interface DatasetSnapshot {
  version: string;
  optimization: DatasetRow[];
  validation: DatasetRow[];
  audit: DatasetRow[];
}
export interface EvaluationCase {
  id: string;
  baseline: number;
  candidate: number;
}
export interface Comparison {
  cases: EvaluationCase[];
  metrics: Record<string, number>;
  estimatedServingCost: number;
  uncertainty?: {
    method: string;
    version: string;
    lowerBound: number;
    assumptionsValid: boolean;
  };
}
export interface Observation {
  artifactVersion: string;
  configurationHash: string;
  startedAt: string;
  endedAt: string;
  complete: boolean;
  unitIds: string[];
  metrics: Record<string, number>;
  /** Required in canary mode: externally computed, versioned randomized comparison. */
  controlVersion?: string | null;
  assignmentHash?: string;
  improvementLowerBound?: number;
  controlUnitIds?: string[];
}
export interface CallbackContext {
  operationId: string;
  signal: AbortSignal;
  /** Immutable identity, not credentials or model-written authority. */
  configuration?: Readonly<{
    workflowId: string;
    workflowVersion: string;
    policyVersion: string;
    optimizerVersion: string;
    evaluatorVersion: string;
    definitionHash: string;
  }>;
  /** Reserve before *each* provider call; return actual usage when known. */
  meter<T>(
    maximumTokens: number,
    call: () => Promise<{ value: T; tokens: number | null }>,
  ): Promise<T>;
}
export interface ImprovementWorkflow {
  id: string;
  version: string;
  optimizerVersion: string;
  evaluatorVersion: string;
  policy: AutonomyPolicy;
  dataset(context: CallbackContext): Promise<DatasetSnapshot>;
  artifact(context: CallbackContext): Promise<ArtifactBaseline>;
  propose(
    input: {
      baseline: ArtifactBaseline;
      examples: DatasetRow[];
      ordinal: number;
      previousOutcomes: { state: string; reason: string }[];
    },
    context: CallbackContext,
  ): Promise<JsonValue[]>;
  evaluate(
    input: {
      baseline: ArtifactBaseline;
      change: JsonValue;
      examples: DatasetRow[];
      partition: "validation" | "audit";
    },
    context: CallbackContext,
  ): Promise<Comparison>;
  deployment: DeploymentAdapter;
  observe(
    input: {
      runId: string;
      artifactVersion: string;
      baseline: ArtifactBaseline;
      deployedAt: string;
    },
    context: CallbackContext,
  ): Promise<Observation>;
  /** Canary apply/rollback use deployment; promotion must retain artifact identity. */
  rollout?: {
    promote(
      input: {
        operationId: string;
        artifactVersion: string;
        baseline: ArtifactBaseline;
      },
      context: CallbackContext,
    ): Promise<void>;
    inspect(
      input: { operationId: string; artifactVersion: string },
      context: CallbackContext,
    ): Promise<"promoted" | "unknown" | "not_applied">;
  };
}
export interface ImprovementRunData {
  workflowId: string;
  definitionHash: string;
  decisionKey: string;
  state: RunState;
  reason: string;
  baseline: ArtifactBaseline;
  dataset: DatasetSnapshot;
  candidateIds: string[];
  comparisons: Record<string, Comparison>;
  selectedId?: string;
  audit?: Comparison;
  auditEvaluationId?: string;
  deployedAt?: string;
  artifactVersion?: string;
  observationConfigurationHash?: string;
  attemptId?: string;
  operation?: "apply" | "rollback";
  proposalCalls: number;
  leaseOwner: string | null;
  leaseUntil: string;
  nextEligibleAt?: string;
  lastObservationId?: string;
  pendingPromotion?: boolean;
  previousOutcomes?: { state: string; reason: string }[];
  configuration?: CallbackContext["configuration"];
  operationIds?: string[];
  assignmentHash?: string;
}
export interface ImprovementRun extends RecordBase {
  format: 1;
  data: ImprovementRunData;
  accounting?: {
    modelRequests: number;
    chargedOrReservedTokens: number;
    deployments: number;
    outstandingOperations: string[];
  };
}
export interface TickResult {
  runId: string | null;
  state: RunState;
  reason: string;
  nextEligibleAt?: string;
  candidateIds: string[];
  budget: { modelRequests: number; tokens: number; deployments: number };
}
export interface ImprovementControllerOptions {
  selfImproving?: boolean;
  mode?: ImprovementMode;
  workflows: ImprovementWorkflow[];
  callbackTimeoutMs?: number;
  tickTimeoutMs?: number;
}
export type ControllerData = JsonObject;
