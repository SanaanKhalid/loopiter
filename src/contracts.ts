export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export const executionKinds = [
  "agent",
  "turn",
  "inference",
  "prediction",
  "tool",
  "workflow",
  "retrieval",
  "custom",
] as const;
export type ExecutionKind = (typeof executionKinds)[number];
export const signalKinds = [
  "rating",
  "correction",
  "outcome",
  "reward",
  "approval",
  "tool_result",
  "custom",
] as const;
export type SignalKind = (typeof signalKinds)[number];
export const targetKinds = [
  "prompt",
  "routing",
  "rule",
  "retrieval",
  "model",
  "dataset",
  "threshold",
  "tool_schema",
  "workflow",
  "agent_topology",
  "code",
  "capacity",
  "custom",
] as const;
export type CandidateTargetKind = (typeof targetKinds)[number];
export const risks = ["low", "medium", "high", "critical"] as const;
export type CandidateRisk = (typeof risks)[number];
export type CandidateStatus =
  | "proposed"
  | "evaluated"
  | "approved"
  | "deployed"
  | "rejected"
  | "superseded"
  | "rolled_back"
  | "historical";
export interface RecordBase {
  id: string;
  namespace: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactVersions extends JsonObject {
  model?: string;
  prompt?: string;
  dataset?: string;
  router?: string;
  policy?: string;
}
export interface RecordExecutionInput {
  id?: string;
  kind: ExecutionKind;
  episodeId?: string;
  parentExecutionId?: string;
  entityId?: string;
  input?: JsonValue;
  output?: JsonValue;
  artifacts?: ArtifactVersions;
  metadata?: JsonObject;
  startedAt?: string;
  completedAt?: string;
}
export interface AiExecution
  extends RecordBase,
    Omit<RecordExecutionInput, "id"> {
  inputHash: string;
  artifacts: ArtifactVersions;
  metadata: JsonObject;
  startedAt: string;
}
export interface CompleteExecutionInput {
  output?: JsonValue;
  metadata?: JsonObject;
  completedAt?: string;
}
export interface RecordSignalInput {
  id?: string;
  executionId?: string;
  episodeId?: string;
  kind: SignalKind;
  name: string;
  value: JsonValue;
  correction?: JsonValue;
  source: string;
  confidence?: number;
  metadata?: JsonObject;
  observedAt?: string;
}
export interface FeedbackSignal
  extends RecordBase,
    Omit<RecordSignalInput, "id"> {
  inputHash: string;
  confidence: number;
  metadata: JsonObject;
  observedAt: string;
}
export interface TimeWindow {
  from?: string;
  to?: string;
}
export interface EvidenceManifest {
  version: 1;
  fingerprint: string;
  executionIds: string[];
  signalIds: string[];
  observationWindow: TimeWindow;
  executionWindow: TimeWindow;
}
export interface Finding {
  id: string;
  namespace: string;
  dimensions: JsonObject;
  support: number;
  executionCount: number;
  uniqueSignalCount: number;
  episodeCount: number;
  scoredCount: number;
  effectiveWeight: number;
  meanScore: number;
  baselineScore: number;
  effectSize: number;
  recurrence: number;
  distinctEntities: number;
  correctionCounts: Record<string, number>;
  evidence: EvidenceManifest;
}
export interface AnalyzeOptions {
  dimensions: string[];
  maximumDimensionDepth?: number;
  executionKinds?: ExecutionKind[];
  signalNames?: string[];
  signalKinds?: SignalKind[];
  executionWindow?: TimeWindow;
  observationWindow?: TimeWindow;
  minimumSupport?: number;
  minimumScoredCount?: number;
  minimumEffectSize?: number;
  minimumRecurrence?: number;
  minimumDistinctEntities?: number;
  timeBucket?: "day" | "week" | "month";
  includeEpisodeSignals?: boolean;
  maximumRecords?: number;
  score?: (signal: FeedbackSignal) => number | undefined;
}
export interface CandidateTarget {
  kind: CandidateTargetKind;
  key: string;
}
export interface CreateCandidateInput {
  id?: string;
  target: CandidateTarget;
  proposedChange: JsonValue;
  evidence: JsonValue;
  risk?: CandidateRisk;
  metadata?: JsonObject;
  baseline?: ArtifactBaseline;
}
export interface ArtifactBaseline {
  artifactVersion: string | null;
  configurationHash: string;
}
export interface EvaluationResult {
  passed: boolean;
  metrics?: Record<string, number>;
  notes?: string;
}
export interface EvaluationContext {
  evaluator: string;
  version: string;
  datasetHash: string;
  signal?: AbortSignal;
}
export interface CandidateEvaluation extends EvaluationResult {
  id: string;
  candidateHash: string;
  evidenceHash: string;
  evaluator: string;
  version: string;
  datasetHash: string;
  createdAt: string;
  baselineHash?: string;
}
export interface CandidateApproval {
  actor: string;
  evaluationId: string;
  candidateHash: string;
  approvedAt: string;
}
export interface AdaptationCandidate extends RecordBase {
  inputHash: string;
  contentHash: string;
  evidenceHash: string;
  target: CandidateTarget;
  proposedChange: JsonValue;
  evidence: JsonValue;
  risk: CandidateRisk;
  metadata: JsonObject;
  evaluations: CandidateEvaluation[];
  status: CandidateStatus;
  approval?: CandidateApproval;
  predecessorId?: string;
  deploymentReceipt?: DeploymentReceipt;
  rollbackReceipt?: DeploymentReceipt;
  baseline?: ArtifactBaseline;
}
export type CandidateEvaluator = (
  candidate: AdaptationCandidate,
  context: { signal: AbortSignal },
) => EvaluationResult | Promise<EvaluationResult>;
export interface TargetState extends RecordBase {
  target: CandidateTarget;
  activeCandidateId?: string;
  pendingAttemptId?: string;
  artifactVersion?: string | null;
}
export interface DeploymentReceipt {
  attemptId: string;
  artifactVersion: string | null;
  previousArtifactVersion: string | null;
  metadata?: JsonObject;
}
export interface DeploymentAttempt extends RecordBase {
  target: CandidateTarget;
  candidateId: string;
  operation: "apply" | "rollback";
  status: "pending" | "succeeded" | "not_applied";
  restoreCandidateId?: string;
  previousCandidateId?: string;
  expectedArtifactVersion: string | null;
  restoreArtifactVersion?: string | null;
  receipt?: DeploymentReceipt;
}
export interface DeploymentRequest {
  attempt: DeploymentAttempt;
  candidate: AdaptationCandidate;
  restoreCandidate?: AdaptationCandidate;
  idempotencyKey: string;
  signal: AbortSignal;
}
export type InspectionResult =
  | { status: "applied"; receipt: DeploymentReceipt }
  | { status: "unknown" }
  | { status: "not_applied" };
/** not_applied MUST mean the attempt is fenced: it cannot take effect later. */
export interface DeploymentAdapter {
  apply(request: DeploymentRequest): Promise<DeploymentReceipt>;
  rollback(request: DeploymentRequest): Promise<DeploymentReceipt>;
  inspect(request: DeploymentRequest): Promise<InspectionResult>;
}
export interface LifecycleEvent extends RecordBase {
  type: string;
  subjectId: string;
  details: JsonObject;
}
export interface HistoricalRecord extends RecordBase {
  original: JsonValue;
}
export interface Collections {
  executions: AiExecution;
  signals: FeedbackSignal;
  candidates: AdaptationCandidate;
  targets: TargetState;
  attempts: DeploymentAttempt;
  events: LifecycleEvent;
  historical: HistoricalRecord;
  runs: ControlRecord;
  operations: ControlRecord;
  budgets: ControlRecord;
  observations: ControlRecord;
  coordination: ControlRecord;
}
/** Versioned controller records. The controller additionally validates its payloads. */
export interface ControlRecord extends RecordBase {
  format: 1;
  data: JsonObject;
}
export type Collection = keyof Collections;
export interface PageOptions {
  limit?: number;
  cursor?: string;
  window?: TimeWindow;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
