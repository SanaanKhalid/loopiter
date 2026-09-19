import type { FeedbackStore, StoreTransaction } from "./store.js";
import type {
  AdaptationCandidate,
  AiExecution,
  AnalyzeOptions,
  CandidateEvaluator,
  CandidateTarget,
  Collection,
  Collections,
  CompleteExecutionInput,
  CreateCandidateInput,
  DeploymentAdapter,
  DeploymentAttempt,
  DeploymentReceipt,
  DeploymentRequest,
  EvaluationContext,
  FeedbackSignal,
  Finding,
  JsonObject,
  JsonValue,
  PageOptions,
  RecordBase,
  RecordExecutionInput,
  RecordSignalInput,
  TargetState,
} from "./contracts.js";
import {
  cancellable,
  clone,
  fail,
  hash,
  id,
  integer,
  json,
  nonempty,
  object,
  timestamp,
} from "./utils.js";
import {
  candidateInput,
  evaluation,
  executionInput,
  fields,
  signalInput,
  stored,
  target,
} from "./validation.js";
import { analyze } from "./analyzer.js";
import { pageOptions, collections } from "./stores/in-memory.js";
export interface FeedbackLoopOptions {
  store: FeedbackStore;
  namespace: string;
  maximumPayloadBytes?: number;
  callbackTimeoutMs?: number;
  clock?: () => Date;
  sanitize?: (input: JsonValue) => JsonValue | Promise<JsonValue>;
  deploymentsEnabled?: () => boolean;
}
export interface DeploymentOptions {
  adapter: DeploymentAdapter;
  expectedArtifactVersion?: string | null;
  signal?: AbortSignal;
  /** Stable caller operation ID. An existing attempt is inspected, never blindly replayed. */
  attemptId?: string;
  authorization?: { runId: string; leaseOwner: string };
}
export class FeedbackLoop {
  readonly namespace: string;
  readonly store: FeedbackStore;
  readonly callbackTimeoutMs: number;
  private readonly options: FeedbackLoopOptions;
  constructor(options: FeedbackLoopOptions) {
    nonempty(options.namespace, "namespace");
    if (options.store?.version !== 3)
      fail(
        "migration_required",
        "A v3 transactional FeedbackStore is required; explicitly migrate first.",
      );
    this.options = { ...options };
    this.namespace = options.namespace;
    this.store = options.store;
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? 120000;
    integer(this.callbackTimeoutMs, "callbackTimeoutMs");
    integer(options.maximumPayloadBytes ?? 262144, "maximumPayloadBytes");
  }
  now(): string {
    const value = (this.options.clock?.() ?? new Date()).toISOString();
    timestamp(value, "clock");
    return value;
  }
  private base(key: string): RecordBase {
    nonempty(key, "id");
    const now = this.now();
    return {
      id: key,
      namespace: this.namespace,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  }
  private next<T extends RecordBase>(row: T): T {
    // Wall clocks can move backwards (NTP or an application-supplied clock).
    // Revisions order transitions; do not persist an invalid update timestamp.
    const updatedAt = new Date(
      Math.max(Date.parse(this.now()), Date.parse(row.updatedAt)),
    ).toISOString();
    return { ...row, revision: row.revision + 1, updatedAt };
  }
  private async prepare<T>(input: T): Promise<T> {
    json(input, this.options.maximumPayloadBytes);
    const result = this.options.sanitize
      ? await this.options.sanitize(clone(input))
      : clone(input);
    json(result, this.options.maximumPayloadBytes);
    return result as T;
  }
  /** Apply the same pre-persistence sanitizer to controller adapter payloads. */
  async prepareControllerPayload<T>(input: T): Promise<T> {
    return this.prepare(input);
  }
  async read<K extends Collection>(
    tx: StoreTransaction,
    kind: K,
    key: string,
  ): Promise<Collections[K] | undefined> {
    nonempty(key, "id");
    const row = await tx.get(kind, key);
    if (row !== undefined) {
      stored(kind, row, this.namespace);
      if (row.id !== key)
        fail("integrity_error", "Adapter returned a different ID.");
    }
    return row;
  }
  private async require<K extends Collection>(
    tx: StoreTransaction,
    kind: K,
    key: string,
  ): Promise<Collections[K]> {
    return (
      (await this.read(tx, kind, key)) ??
      fail("not_found", `${kind} record not found in this namespace.`)
    );
  }
  private async event(
    tx: StoreTransaction,
    type: string,
    subjectId: string,
    details: JsonObject = {},
  ): Promise<void> {
    await tx.insert("events", {
      ...this.base(id("event")),
      type,
      subjectId,
      details,
    });
  }
  async list<K extends Collection>(kind: K, options: PageOptions = {}) {
    const limit = pageOptions(options);
    if (!collections.includes(kind))
      fail("invalid_input", "Invalid collection.");
    return this.store.transaction(this.namespace, async (tx) => {
      const page = await tx.list(kind, options);
      object(page, "adapter page");
      if (!Array.isArray(page.items))
        fail("integrity_error", "Adapter page must contain items.");
      if (page.nextCursor !== undefined)
        nonempty(page.nextCursor, "nextCursor");
      if (page.items.length > limit)
        fail("integrity_error", "Adapter exceeded page limit.");
      for (const row of page.items) stored(kind, row, this.namespace);
      return page;
    });
  }
  getExecution(key: string): Promise<AiExecution | undefined> {
    return this.store.transaction(this.namespace, (tx) =>
      this.read(tx, "executions", key),
    );
  }
  getCandidate(key: string): Promise<AdaptationCandidate | undefined> {
    return this.store.transaction(this.namespace, (tx) =>
      this.read(tx, "candidates", key),
    );
  }
  async getActiveCandidate(
    value: CandidateTarget,
  ): Promise<AdaptationCandidate | undefined> {
    target(value);
    return this.store.transaction(this.namespace, async (tx) => {
      const state = await this.read(tx, "targets", hash(value));
      return state?.activeCandidateId
        ? this.require(tx, "candidates", state.activeCandidateId)
        : undefined;
    });
  }
  async recordExecution(raw: RecordExecutionInput): Promise<AiExecution> {
    executionInput(raw);
    const input = await this.prepare(raw);
    executionInput(input);
    const row: AiExecution = {
      ...input,
      ...this.base(input.id ?? id("exec")),
      inputHash: hash(input),
      artifacts: input.artifacts ?? {},
      metadata: input.metadata ?? {},
      startedAt: input.startedAt ?? this.now(),
    };
    executionInput({ ...input, startedAt: row.startedAt });
    return this.store.transaction(this.namespace, async (tx) => {
      const existing = await this.read(tx, "executions", row.id);
      if (existing) {
        if (existing.inputHash !== row.inputHash)
          fail("conflict", "Execution ID has different input.");
        return existing;
      }
      if (input.parentExecutionId) {
        const parent = await this.require(
          tx,
          "executions",
          input.parentExecutionId,
        );
        if (parent.episodeId !== input.episodeId)
          fail("invalid_input", "Parent and child must share the episode.");
      }
      await tx.insert("executions", row);
      return row;
    });
  }
  async completeExecution(
    key: string,
    raw: CompleteExecutionInput,
    expectedRevision: number,
  ): Promise<AiExecution> {
    integer(expectedRevision, "expectedRevision");
    fields(raw, ["output", "metadata", "completedAt"]);
    const input: CompleteExecutionInput =
      await this.prepare<CompleteExecutionInput>(raw);
    fields(input, ["output", "metadata", "completedAt"]);
    if (input.metadata !== undefined) object(input.metadata, "metadata");
    if (input.completedAt !== undefined)
      timestamp(input.completedAt, "completedAt");
    const completion: CompleteExecutionInput = {
      ...(input as CompleteExecutionInput),
    };
    return this.store.transaction(this.namespace, async (tx) => {
      const current = await this.require(tx, "executions", key);
      if (current.revision !== expectedRevision)
        fail("conflict", "Execution changed.");
      const updated = {
        ...this.next(current),
        ...completion,
        metadata: { ...current.metadata, ...completion.metadata },
        completedAt: completion.completedAt ?? this.now(),
      };
      if (Date.parse(updated.completedAt) < Date.parse(updated.startedAt))
        fail("invalid_input", "Completion predates execution.");
      await tx.replace("executions", updated, current.revision);
      return updated;
    });
  }
  async recordSignal(raw: RecordSignalInput): Promise<FeedbackSignal> {
    signalInput(raw);
    const input = await this.prepare(raw);
    signalInput(input);
    const row: FeedbackSignal = {
      ...input,
      ...this.base(input.id ?? id("signal")),
      inputHash: hash(input),
      confidence: input.confidence ?? 1,
      metadata: input.metadata ?? {},
      observedAt: input.observedAt ?? this.now(),
    };
    return this.store.transaction(this.namespace, async (tx) => {
      const existing = await this.read(tx, "signals", row.id);
      if (existing) {
        if (existing.inputHash !== row.inputHash)
          fail("conflict", "Signal ID has different input.");
        return existing;
      }
      if (row.executionId) {
        const execution = await this.require(tx, "executions", row.executionId);
        if (
          row.episodeId !== undefined &&
          execution.episodeId !== row.episodeId
        )
          fail("invalid_input", "Signal episode does not match execution.");
      }
      await tx.insert("signals", row);
      return row;
    });
  }
  analyze(options: AnalyzeOptions): Promise<Finding[]> {
    return analyze(this, options);
  }
  async createCandidate(
    raw: CreateCandidateInput,
  ): Promise<AdaptationCandidate> {
    candidateInput(raw);
    const input = await this.prepare(raw);
    candidateInput(input);
    const risk = input.risk ?? "medium";
    const row: AdaptationCandidate = {
      ...input,
      ...this.base(input.id ?? id("candidate")),
      inputHash: hash(input),
      risk,
      metadata: input.metadata ?? {},
      evaluations: [],
      status: "proposed",
      contentHash: hash({
        target: input.target,
        proposedChange: input.proposedChange,
        risk,
        metadata: input.metadata ?? {},
        ...(input.baseline ? { baseline: input.baseline } : {}),
      }),
      evidenceHash: hash(input.evidence),
    };
    return this.store.transaction(this.namespace, async (tx) => {
      const previous = await this.read(tx, "candidates", row.id);
      if (previous) {
        if (previous.inputHash !== row.inputHash)
          fail("conflict", "Candidate ID has different input.");
        return previous;
      }
      await tx.insert("candidates", row);
      await this.event(tx, "candidate.created", row.id);
      return row;
    });
  }
  private async unlocked(
    tx: StoreTransaction,
    candidate: AdaptationCandidate,
  ): Promise<void> {
    const state = await this.read(tx, "targets", hash(candidate.target));
    if (state?.pendingAttemptId)
      fail(
        "deployment_pending",
        `Reconcile attempt ${state.pendingAttemptId} first.`,
      );
  }
  async evaluateCandidate(
    key: string,
    context: EvaluationContext,
    evaluator: CandidateEvaluator,
  ): Promise<AdaptationCandidate> {
    nonempty(context.evaluator, "evaluator");
    nonempty(context.version, "evaluator version");
    nonempty(context.datasetHash, "datasetHash");
    context = { ...context }; // Freeze identity inputs across the external callback.
    const snapshot = await this.store.transaction(
      this.namespace,
      async (tx) => {
        const c = await this.require(tx, "candidates", key);
        await this.unlocked(tx, c);
        if (!["proposed", "evaluated"].includes(c.status))
          fail(
            "invalid_transition",
            "Candidate cannot be evaluated from this state.",
          );
        return c;
      },
    );
    const rawResult = await cancellable(
      (signal) => evaluator(clone(snapshot), { signal }),
      context.signal,
      this.callbackTimeoutMs,
    );
    evaluation(rawResult);
    const result = await this.prepare(rawResult);
    evaluation(result);
    context.signal?.throwIfAborted();
    return this.store.transaction(this.namespace, async (tx) => {
      context.signal?.throwIfAborted();
      const current = await this.require(tx, "candidates", key);
      await this.unlocked(tx, current);
      if (current.revision !== snapshot.revision)
        fail(
          "conflict",
          "Candidate changed during evaluation; result discarded.",
        );
      const updated = this.next(current);
      updated.status = "evaluated";
      updated.evaluations.push({
        ...clone(result),
        id: id("eval"),
        candidateHash: current.contentHash,
        evidenceHash: current.evidenceHash,
        evaluator: context.evaluator,
        version: context.version,
        datasetHash: context.datasetHash,
        createdAt: this.now(),
        ...(current.baseline ? { baselineHash: hash(current.baseline) } : {}),
      });
      await tx.replace("candidates", updated, current.revision);
      await this.event(tx, "candidate.evaluated", key, {
        passed: result.passed,
      });
      return updated;
    });
  }
  async approveCandidate(
    key: string,
    input: {
      actor: string;
      evaluationId: string;
      authorization?: { runId: string; leaseOwner: string };
    },
  ): Promise<AdaptationCandidate> {
    fields(input, ["actor", "evaluationId", "authorization"]);
    nonempty(input.actor, "actor");
    nonempty(input.evaluationId, "evaluationId");
    const authorization = input.authorization
      ? clone(input.authorization)
      : undefined;
    input = { actor: input.actor, evaluationId: input.evaluationId };
    return this.store.transaction(this.namespace, async (tx) => {
      if (authorization) await this.authorizeAutonomous(tx, key, authorization);
      const current = await this.require(tx, "candidates", key);
      await this.unlocked(tx, current);
      const e = current.evaluations.at(-1);
      if (
        current.status !== "evaluated" ||
        !e?.passed ||
        e.id !== input.evaluationId ||
        e.candidateHash !== current.contentHash ||
        e.evidenceHash !== current.evidenceHash
      )
        fail(
          "invalid_transition",
          "Approval requires the exact latest passing evaluation.",
        );
      const updated = {
        ...this.next(current),
        status: "approved" as const,
        approval: {
          ...input,
          candidateHash: current.contentHash,
          approvedAt: this.now(),
        },
      };
      await tx.replace("candidates", updated, current.revision);
      await this.event(tx, "candidate.approved", key, {
        actor: input.actor,
        evaluationId: input.evaluationId,
      });
      return updated;
    });
  }
  private async authorizeAutonomous(
    tx: StoreTransaction,
    key: string,
    authorization: { runId: string; leaseOwner: string },
  ) {
    fields(authorization, ["runId", "leaseOwner"]);
    nonempty(authorization.runId, "runId");
    nonempty(authorization.leaseOwner, "leaseOwner");
    const run = await this.require(tx, "runs", authorization.runId),
      d = run.data;
    const control = await this.read(
      tx,
      "coordination",
      `workflow:${String(d.workflowId)}`,
    );
    const candidate = await this.require(tx, "candidates", key);
    if (
      typeof d.auditEvaluationId !== "string" ||
      candidate.evaluations.at(-1)?.id !== d.auditEvaluationId
    )
      fail(
        "audit_evaluation_conflict",
        "Autonomous approval/deployment requires the exact recorded audit.",
      );
    if (
      d.leaseOwner !== authorization.leaseOwner ||
      typeof d.leaseUntil !== "string" ||
      Date.parse(d.leaseUntil) <= Date.parse(this.now()) ||
      d.selectedId !== key ||
      !["selected", "deploying"].includes(String(d.state)) ||
      control?.data.paused === true ||
      control?.data.mode !== "autonomous" ||
      control?.data.selfImproving !== true ||
      control?.data.definitionHash !== d.definitionHash
    )
      fail(
        "autonomy_not_authorized",
        "Current durable controller authorization is required.",
      );
  }
  async rejectCandidate(
    key: string,
    reason: string,
  ): Promise<AdaptationCandidate> {
    nonempty(reason, "reason");
    return this.store.transaction(this.namespace, async (tx) => {
      const current = await this.require(tx, "candidates", key);
      await this.unlocked(tx, current);
      if (!["proposed", "evaluated", "approved"].includes(current.status))
        fail("invalid_transition", "Candidate cannot be rejected.");
      const updated = { ...this.next(current), status: "rejected" as const };
      delete updated.approval;
      await tx.replace("candidates", updated, current.revision);
      await this.event(tx, "candidate.rejected", key, { reason });
      return updated;
    });
  }
  private checkAdapter(adapter: DeploymentAdapter): void {
    if (
      !adapter ||
      ["apply", "inspect", "rollback"].some(
        (key) => typeof adapter[key as keyof DeploymentAdapter] !== "function",
      )
    )
      fail("invalid_adapter", "apply, inspect and rollback are required.");
  }
  private enabled(): void {
    if (
      this.options.deploymentsEnabled &&
      this.options.deploymentsEnabled() !== true
    )
      fail("deployment_disabled", "Deployments are disabled.");
  }
  async deployCandidate(
    key: string,
    options: DeploymentOptions,
  ): Promise<DeploymentAttempt> {
    this.enabled();
    return this.startDeployment(key, "apply", options);
  }
  async rollbackCandidate(
    key: string,
    options: DeploymentOptions,
  ): Promise<DeploymentAttempt> {
    return this.startDeployment(key, "rollback", options);
  }
  private async startDeployment(
    key: string,
    operation: "apply" | "rollback",
    options: DeploymentOptions,
  ): Promise<DeploymentAttempt> {
    this.checkAdapter(options.adapter);
    options.signal?.throwIfAborted();
    if (options.attemptId !== undefined) {
      nonempty(options.attemptId, "attemptId");
      const previous = await this.store.transaction(this.namespace, (tx) =>
        this.read(tx, "attempts", options.attemptId!),
      );
      if (previous) {
        if (previous.candidateId !== key || previous.operation !== operation)
          fail("conflict", "Attempt ID reused for different operation.");
        return this.reconcileAttempt(
          previous.id,
          options.adapter,
          options.signal,
        );
      }
    }
    if (
      options.expectedArtifactVersion !== undefined &&
      options.expectedArtifactVersion !== null
    )
      nonempty(options.expectedArtifactVersion, "expectedArtifactVersion");
    const attempt = await this.store.transaction(this.namespace, async (tx) => {
      options.signal?.throwIfAborted();
      if (operation === "apply") this.enabled();
      if (operation === "apply" && options.authorization)
        await this.authorizeAutonomous(tx, key, options.authorization);
      const candidate = await this.require(tx, "candidates", key);
      const stateId = hash(candidate.target);
      const coordination = await this.read(
        tx,
        "coordination",
        `target:${stateId}`,
      );
      if (
        operation === "apply" &&
        coordination?.data.activeRun &&
        coordination.data.activeRun !== options.authorization?.runId
      )
        fail(
          "target_busy",
          "An improvement cycle owns this target. Finish observation or recover it before a separate deployment.",
        );
      const existing = await this.read(tx, "targets", stateId);
      if (existing?.pendingAttemptId)
        fail(
          "deployment_pending",
          `Reconcile attempt ${existing.pendingAttemptId} first.`,
        );
      if (operation === "apply") {
        const e = candidate.evaluations.at(-1);
        if (
          candidate.status !== "approved" ||
          !e?.passed ||
          candidate.approval?.evaluationId !== e.id ||
          candidate.approval.candidateHash !== candidate.contentHash
        )
          fail(
            "invalid_transition",
            "Deployment requires exact approved content.",
          );
      } else if (
        candidate.status !== "deployed" ||
        existing?.activeCandidateId !== key ||
        !candidate.deploymentReceipt
      )
        fail(
          "invalid_transition",
          "Rollback requires the active deployed candidate.",
        );
      const state: TargetState = existing
        ? this.next(existing)
        : { ...this.base(stateId), target: candidate.target };
      const expected =
        existing?.artifactVersion !== undefined
          ? existing.artifactVersion
          : (options.expectedArtifactVersion ??
            candidate.baseline?.artifactVersion ??
            null);
      if (
        operation === "apply" &&
        candidate.baseline &&
        candidate.baseline.artifactVersion !== expected
      )
        fail("stale_baseline", "Evaluated baseline is no longer current.");
      if (
        options.expectedArtifactVersion !== undefined &&
        expected !== options.expectedArtifactVersion
      )
        fail("conflict", "Expected artifact version changed.");
      const value: DeploymentAttempt = {
        ...this.base(options.attemptId ?? id("attempt")),
        target: candidate.target,
        candidateId: key,
        operation,
        status: "pending",
        expectedArtifactVersion: expected,
        ...(existing?.activeCandidateId
          ? { previousCandidateId: existing.activeCandidateId }
          : {}),
        ...(operation === "rollback"
          ? {
              restoreArtifactVersion:
                candidate.deploymentReceipt!.previousArtifactVersion,
              ...(candidate.predecessorId
                ? { restoreCandidateId: candidate.predecessorId }
                : {}),
            }
          : {}),
      };
      if (value.restoreCandidateId) {
        const restore = await this.require(
          tx,
          "candidates",
          value.restoreCandidateId,
        );
        if (restore.status !== "superseded")
          fail(
            "invalid_transition",
            "Predecessor is not eligible for restoration.",
          );
      }
      state.pendingAttemptId = value.id;
      if (existing) await tx.replace("targets", state, existing.revision);
      else await tx.insert("targets", state);
      await tx.insert("attempts", value);
      await this.event(tx, "deployment.pending", key, {
        attemptId: value.id,
        operation,
      });
      return value;
    });
    return this.executeAttempt(attempt, options.adapter, false, options.signal);
  }
  private async request(
    attempt: DeploymentAttempt,
    signal: AbortSignal,
  ): Promise<DeploymentRequest> {
    return this.store
      .transaction(this.namespace, async (tx) => ({
        attempt,
        candidate: await this.require(tx, "candidates", attempt.candidateId),
        ...(attempt.restoreCandidateId
          ? {
              restoreCandidate: await this.require(
                tx,
                "candidates",
                attempt.restoreCandidateId,
              ),
            }
          : {}),
        idempotencyKey: attempt.id,
      }))
      .then((value) => ({ ...value, signal }));
  }
  async reconcileAttempt(
    key: string,
    adapter: DeploymentAdapter,
    signal?: AbortSignal,
  ): Promise<DeploymentAttempt> {
    this.checkAdapter(adapter);
    const attempt = await this.store.transaction(this.namespace, (tx) =>
      this.require(tx, "attempts", key),
    );
    if (attempt.status !== "pending") return attempt;
    return this.executeAttempt(attempt, adapter, true, signal);
  }
  private async executeAttempt(
    attempt: DeploymentAttempt,
    adapter: DeploymentAdapter,
    inspect: boolean,
    signal?: AbortSignal,
  ): Promise<DeploymentAttempt> {
    // All failures leave the target reserved; inspect is the only safe retry entrypoint.
    try {
      const outcome = await cancellable(
        async (inner) => {
          const request = await this.request(attempt, inner);
          inner.throwIfAborted();
          if (inspect) return adapter.inspect(request);
          if (attempt.operation === "apply") this.enabled();
          return {
            status: "applied" as const,
            receipt: await adapter[attempt.operation](request),
          };
        },
        signal,
        this.callbackTimeoutMs,
      );
      object(outcome, "inspection");
      if (outcome.status === "unknown") return attempt;
      if (outcome.status !== "applied" && outcome.status !== "not_applied")
        fail("invalid_receipt", "Invalid inspection status.");
      if (outcome.status === "applied")
        object(outcome.receipt, "deployment receipt");
      return await this.finalize(
        attempt,
        outcome.status === "applied" ? outcome.receipt : undefined,
      );
    } catch (error) {
      throw Object.assign(
        new Error(
          `Deployment ${attempt.id} remains pending; inspect before retrying.`,
          { cause: error },
        ),
        { code: "deployment_pending", attemptId: attempt.id },
      );
    }
  }
  private async finalize(
    snapshot: DeploymentAttempt,
    receipt?: DeploymentReceipt,
  ): Promise<DeploymentAttempt> {
    if (receipt) {
      receipt = await this.prepare(receipt);
      object(receipt, "sanitized receipt");
      json(receipt);
      nonempty(receipt.attemptId, "receipt attemptId");
      if (receipt.artifactVersion !== null)
        nonempty(receipt.artifactVersion, "artifactVersion");
      if (receipt.previousArtifactVersion !== null)
        nonempty(receipt.previousArtifactVersion, "previousArtifactVersion");
      if (
        receipt.attemptId !== snapshot.id ||
        receipt.previousArtifactVersion !== snapshot.expectedArtifactVersion ||
        (snapshot.operation === "apply" && receipt.artifactVersion === null) ||
        (snapshot.operation === "rollback" &&
          receipt.artifactVersion !== snapshot.restoreArtifactVersion)
      )
        fail("invalid_receipt", "Receipt does not match the attempt.");
    }
    return this.store.transaction(this.namespace, async (tx) => {
      const current = await this.require(tx, "attempts", snapshot.id);
      if (current.status !== "pending") {
        if (hash(current.receipt ?? null) !== hash(receipt ?? null))
          fail("conflict", "Attempt finalized with different result.");
        return current;
      }
      const state = await this.require(tx, "targets", hash(current.target));
      if (state.pendingAttemptId !== current.id)
        fail("conflict", "Target reservation changed.");
      const nextState = this.next(state);
      delete nextState.pendingAttemptId;
      const updated = {
        ...this.next(current),
        status: receipt ? ("succeeded" as const) : ("not_applied" as const),
        ...(receipt ? { receipt: clone(receipt) } : {}),
      };
      if (receipt) {
        const candidate = await this.require(
          tx,
          "candidates",
          current.candidateId,
        );
        const nextCandidate = this.next(candidate);
        nextState.artifactVersion = receipt.artifactVersion;
        if (current.operation === "apply") {
          if (current.previousCandidateId) {
            const previous = await this.require(
              tx,
              "candidates",
              current.previousCandidateId,
            );
            await tx.replace(
              "candidates",
              { ...this.next(previous), status: "superseded" },
              previous.revision,
            );
            nextCandidate.predecessorId = previous.id;
          }
          nextCandidate.status = "deployed";
          nextCandidate.deploymentReceipt = clone(receipt);
          nextState.activeCandidateId = candidate.id;
        } else {
          nextCandidate.status = "rolled_back";
          nextCandidate.rollbackReceipt = clone(receipt);
          delete nextState.activeCandidateId;
          if (current.restoreCandidateId) {
            const restore = await this.require(
              tx,
              "candidates",
              current.restoreCandidateId,
            );
            if (restore.status !== "superseded")
              fail("conflict", "Predecessor changed.");
            await tx.replace(
              "candidates",
              { ...this.next(restore), status: "deployed" },
              restore.revision,
            );
            nextState.activeCandidateId = restore.id;
          }
        }
        await tx.replace("candidates", nextCandidate, candidate.revision);
      }
      await tx.replace("targets", nextState, state.revision);
      await tx.replace("attempts", updated, current.revision);
      await this.event(
        tx,
        `deployment.${updated.status}`,
        current.candidateId,
        { attemptId: current.id, operation: current.operation },
      );
      return updated;
    });
  }
  async deleteNamespace(confirmation: string): Promise<void> {
    if (confirmation !== this.namespace)
      fail("invalid_input", "Confirm the exact namespace.");
    await this.store.deleteNamespace(this.namespace);
  }
  close(): Promise<void> {
    return this.store.close();
  }
}
