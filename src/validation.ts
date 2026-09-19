import {
  executionKinds,
  signalKinds,
  targetKinds,
  risks,
  type CandidateTarget,
  type Collections,
  type Collection,
  type EvaluationResult,
} from "./contracts.js";
import {
  enumeration,
  fail,
  finite,
  hash,
  integer,
  json,
  nonempty,
  object,
  timestamp,
} from "./utils.js";
export function fields(
  value: unknown,
  allowed: string[],
): asserts value is Record<string, unknown> {
  object(value, "input");
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("invalid_input", `Unknown field: ${key}`);
}
export function target(value: unknown): asserts value is CandidateTarget {
  fields(value, ["kind", "key"]);
  enumeration(value.kind, targetKinds, "target.kind");
  nonempty(value.key, "target.key");
}
export function executionInput(value: unknown): void {
  fields(value, [
    "id",
    "kind",
    "episodeId",
    "parentExecutionId",
    "entityId",
    "input",
    "output",
    "artifacts",
    "metadata",
    "startedAt",
    "completedAt",
  ]);
  enumeration(value.kind, executionKinds, "execution kind");
  for (const key of ["id", "episodeId", "parentExecutionId", "entityId"])
    if (value[key] !== undefined) nonempty(value[key], key);
  for (const key of ["startedAt", "completedAt"])
    if (value[key] !== undefined) timestamp(value[key], key);
  for (const key of ["artifacts", "metadata"])
    if (value[key] !== undefined) object(value[key], key);
  if (
    value.startedAt &&
    value.completedAt &&
    Date.parse(value.completedAt as string) <
      Date.parse(value.startedAt as string)
  )
    fail("invalid_input", "Completion predates execution.");
}
export function signalInput(value: unknown): void {
  fields(value, [
    "id",
    "executionId",
    "episodeId",
    "kind",
    "name",
    "value",
    "correction",
    "source",
    "confidence",
    "metadata",
    "observedAt",
  ]);
  enumeration(value.kind, signalKinds, "signal kind");
  nonempty(value.name, "signal name");
  nonempty(value.source, "signal source");
  if (!Object.hasOwn(value, "value"))
    fail("invalid_input", "Signal value is required.");
  if (!value.executionId && !value.episodeId)
    fail("invalid_input", "Signal requires executionId or episodeId.");
  for (const key of ["id", "episodeId", "executionId"])
    if (value[key] !== undefined) nonempty(value[key], key);
  if (value.observedAt !== undefined) timestamp(value.observedAt, "observedAt");
  if (value.metadata !== undefined) object(value.metadata, "metadata");
  if (value.confidence !== undefined) {
    finite(value.confidence, "confidence", 0);
    if (value.confidence > 1) fail("invalid_input", "Confidence exceeds 1.");
  }
}
export function candidateInput(value: unknown): void {
  fields(value, [
    "id",
    "target",
    "proposedChange",
    "evidence",
    "risk",
    "metadata",
    "baseline",
  ]);
  target(value.target);
  if (value.baseline !== undefined) {
    fields(value.baseline, ["artifactVersion", "configurationHash"]);
    if (value.baseline.artifactVersion !== null) nonempty(value.baseline.artifactVersion, "baseline version");
    nonempty(value.baseline.configurationHash, "baseline configurationHash");
  }
  if (
    !Object.hasOwn(value, "proposedChange") ||
    !Object.hasOwn(value, "evidence")
  )
    fail("invalid_input", "Candidate requires proposedChange and evidence.");
  if (value.id !== undefined) nonempty(value.id, "id");
  if (value.risk !== undefined) enumeration(value.risk, risks, "risk");
  if (value.metadata !== undefined) object(value.metadata, "metadata");
}
export function evaluation(value: unknown): asserts value is EvaluationResult {
  fields(value, ["passed", "metrics", "notes"]);
  json(value);
  if (typeof value.passed !== "boolean")
    fail("invalid_input", "Evaluation passed must be boolean.");
  if (value.metrics !== undefined) {
    object(value.metrics, "metrics");
    for (const [name, number] of Object.entries(value.metrics)) {
      nonempty(name, "metric");
      finite(number, name);
    }
  }
  if (value.notes !== undefined && typeof value.notes !== "string")
    fail("invalid_input", "Notes must be text.");
}
export function stored<K extends Collection>(
  kind: K,
  row: Collections[K],
  namespace: string,
): void {
  object(row, "adapter record");
  json(row, 16 * 1024 * 1024);
  nonempty(row.id, "stored id");
  integer(row.revision, "revision");
  timestamp(row.createdAt, "createdAt");
  timestamp(row.updatedAt, "updatedAt");
  if (row.namespace !== namespace)
    fail("namespace_mismatch", "Adapter returned another namespace.");
  if (Date.parse(row.updatedAt) < Date.parse(row.createdAt))
    fail("integrity_error", "Record update predates creation.");
  if (kind === "executions") {
    const r = row as Collections["executions"];
    enumeration(r.kind, executionKinds, "stored kind");
    timestamp(r.startedAt, "startedAt");
    if (r.completedAt !== undefined) timestamp(r.completedAt, "completedAt");
    nonempty(r.inputHash, "inputHash");
    object(r.metadata, "metadata");
    object(r.artifacts, "artifacts");
  } else if (kind === "signals") {
    const r = row as Collections["signals"];
    enumeration(r.kind, signalKinds, "stored kind");
    nonempty(r.name, "signal name");
    nonempty(r.source, "source");
    finite(r.confidence, "confidence", 0);
    if (r.confidence > 1) fail("invalid_input", "Invalid stored confidence.");
    timestamp(r.observedAt, "observedAt");
    if (!r.executionId && !r.episodeId)
      fail("invalid_input", "Unattributable signal.");
    nonempty(r.inputHash, "inputHash");
    object(r.metadata, "metadata");
  } else if (kind === "candidates") {
    const r = row as Collections["candidates"];
    if(r.baseline!==undefined){fields(r.baseline,['artifactVersion','configurationHash']);if(r.baseline.artifactVersion!==null)nonempty(r.baseline.artifactVersion,'baseline version');nonempty(r.baseline.configurationHash,'baseline configuration');}
    target(r.target);
    enumeration(r.risk, risks, "stored risk");
    enumeration(
      r.status,
      [
        "proposed",
        "evaluated",
        "approved",
        "deployed",
        "rejected",
        "superseded",
        "rolled_back",
        "historical",
      ],
      "candidate status",
    );
    if (
      r.contentHash !==
        hash({
          target: r.target,
          proposedChange: r.proposedChange,
          risk: r.risk,
          metadata: r.metadata,
          ...(r.baseline ? { baseline: r.baseline } : {}),
        }) ||
      r.evidenceHash !== hash(r.evidence)
    )
      fail("integrity_error", "Candidate content/evidence hash mismatch.");
    if (!Array.isArray(r.evaluations))
      fail("invalid_input", "Invalid evaluations.");
    nonempty(r.inputHash, "inputHash");
    object(r.metadata, "metadata");
    for (const e of r.evaluations) {
      evaluation({
        passed: e.passed,
        ...(e.metrics !== undefined ? { metrics: e.metrics } : {}),
        ...(e.notes !== undefined ? { notes: e.notes } : {}),
      });
      nonempty(e.id, "evaluation ID");
      nonempty(e.evaluator, "evaluator");
      nonempty(e.version, "evaluator version");
      nonempty(e.datasetHash, "dataset hash");
      timestamp(e.createdAt, "evaluation time");
      if (r.baseline && e.baselineHash !== hash(r.baseline)) fail("integrity_error", "Evaluation baseline mismatch.");
      if (
        e.candidateHash !== r.contentHash ||
        e.evidenceHash !== r.evidenceHash
      )
        fail("integrity_error", "Evaluation is bound to different content.");
    }
    if (r.approval) {
      nonempty(r.approval.actor, "approver");
      timestamp(r.approval.approvedAt, "approval time");
      const latest = r.evaluations.at(-1);
      if (
        !latest?.passed ||
        latest.id !== r.approval.evaluationId ||
        r.approval.candidateHash !== r.contentHash
      )
        fail(
          "integrity_error",
          "Approval does not match the latest passing evaluation.",
        );
    }
    if (
      ["approved", "deployed", "superseded", "rolled_back"].includes(
        r.status,
      ) &&
      !r.approval
    )
      fail("integrity_error", "Approved lifecycle record has no approval.");
    if (r.deploymentReceipt) receipt(r.deploymentReceipt);
    if (r.rollbackReceipt) receipt(r.rollbackReceipt);
  } else if (kind === "targets") {
    const r = row as Collections["targets"];
    target(r.target);
    if (r.id !== hash(r.target))
      fail("integrity_error", "Target identity mismatch.");
    for (const field of ["activeCandidateId", "pendingAttemptId"] as const)
      if (r[field] !== undefined) nonempty(r[field], field);
    if (r.artifactVersion !== undefined && r.artifactVersion !== null)
      nonempty(r.artifactVersion, "artifactVersion");
  } else if (kind === "attempts") {
    const r = row as Collections["attempts"];
    target(r.target);
    nonempty(r.candidateId, "candidateId");
    enumeration(r.operation, ["apply", "rollback"], "operation");
    enumeration(
      r.status,
      ["pending", "succeeded", "not_applied"],
      "attempt status",
    );
    if (r.expectedArtifactVersion !== null)
      nonempty(r.expectedArtifactVersion, "expectedArtifactVersion");
    if (r.operation === "rollback" && r.restoreArtifactVersion !== null)
      nonempty(r.restoreArtifactVersion, "restoreArtifactVersion");
    if (r.receipt) {
      receipt(r.receipt);
      if (r.receipt.attemptId !== r.id)
        fail("integrity_error", "Attempt receipt mismatch.");
    }
    if (r.status === "succeeded" && !r.receipt)
      fail("integrity_error", "Successful attempt has no receipt.");
  } else if (["runs", "operations", "budgets", "observations", "coordination"].includes(kind)) {
    const r = row as Collections["runs"];
    if (r.format !== 1) fail("integrity_error", "Unknown controller record format.");
    object(r.data, "controller data");
    if(kind==='budgets')for(const key of ['modelRequests','tokens','deployments'])integer(r.data[key],key,0);
  } else if (kind === "events") {
    const r = row as Collections["events"];
    nonempty(r.type, "event type");
    nonempty(r.subjectId, "subjectId");
    object(r.details, "event details");
  }
}
function receipt(value: unknown): void {
  fields(value, [
    "attemptId",
    "artifactVersion",
    "previousArtifactVersion",
    "metadata",
  ]);
  nonempty(value.attemptId, "attemptId");
  for (const field of ["artifactVersion", "previousArtifactVersion"])
    if (value[field] !== null) nonempty(value[field], field);
  if (value.metadata !== undefined) object(value.metadata, "receipt metadata");
}
