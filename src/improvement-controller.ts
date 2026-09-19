import type { FeedbackLoop } from "./feedback-loop.js";
import type {
  ControlRecord,
  JsonObject,
  JsonValue,
  PageOptions,
  ArtifactBaseline,
} from "./contracts.js";
import type { StoreTransaction } from "./store.js";
import type {
  CallbackContext,
  Comparison,
  ImprovementControllerOptions,
  ImprovementRun,
  ImprovementRunData,
  ImprovementWorkflow,
  Observation,
  RunState,
  TickResult,
} from "./improvement-contracts.js";
import {
  compare,
  passesGates,
  prepareDataset,
  validateChange,
  validatePolicy,
} from "./improvement-evidence.js";
import {
  cancellable,
  clone,
  enumeration,
  fail,
  hash,
  id,
  integer,
  json,
  nonempty,
  object,
  timestamp,
} from "./utils.js";

const terminal: RunState[] = [
  "completed",
  "no_improvement",
  "failed",
  "rolled_back",
];
const states: RunState[] = [
  "waiting_for_evidence",
  "proposing",
  "evaluating",
  "selected",
  "deploying",
  "observing",
  "completed",
  "no_improvement",
  "paused",
  "failed",
  "reconciliation_required",
  "rolling_back",
  "rolled_back",
];
const asJson = (x: unknown) => x as JsonObject;
const plus = (time: string, ms: number) =>
  new Date(Date.parse(time) + ms).toISOString();

/** No background work. One tick advances one durable phase; application owns scheduling. */
export class ImprovementController {
  private readonly options: ImprovementControllerOptions;
  private readonly workflows = new Map<string, ImprovementWorkflow>();
  private readonly definitions = new Map<string, string>();
  private readonly callbackMs: number;
  private readonly tickMs: number;
  constructor(
    readonly loop: FeedbackLoop,
    options: ImprovementControllerOptions,
  ) {
    if ("experimentalAutoApply" in options || "autonomy" in options)
      fail(
        "migration_required",
        "Use mode and the explicit selfImproving flag.",
      );
    if (
      options.selfImproving !== undefined &&
      typeof options.selfImproving !== "boolean"
    )
      fail("invalid_input", "selfImproving must be boolean.");
    enumeration(
      options.mode ?? "recommend",
      ["observe", "recommend", "experiment", "autonomous"],
      "mode",
    );
    this.options = { ...options };
    this.callbackMs = options.callbackTimeoutMs ?? 120000;
    this.tickMs = options.tickTimeoutMs ?? 600000;
    integer(this.callbackMs, "callbackTimeoutMs");
    integer(this.tickMs, "tickTimeoutMs");
    if (this.callbackMs > 120000 || this.tickMs > 600000)
      fail(
        "invalid_input",
        "Deadlines may be shortened, not extended beyond 2/10 minutes.",
      );
    if (!Array.isArray(options.workflows) || !options.workflows.length)
      fail("invalid_input", "Workflows required.");
    for (const raw of options.workflows) {
      const w = { ...raw, policy: clone(raw.policy) };
      for (const k of [
        "id",
        "version",
        "optimizerVersion",
        "evaluatorVersion",
      ] as const)
        nonempty(w[k], k);
      validatePolicy(w.policy);
      for (const k of [
        "dataset",
        "artifact",
        "propose",
        "evaluate",
        "observe",
      ] as const)
        if (typeof w[k] !== "function")
          fail("invalid_adapter", `Missing ${k}.`);
      for (const k of ["apply", "inspect", "rollback"] as const)
        if (typeof w.deployment?.[k] !== "function")
          fail("invalid_adapter", `Missing ${k}.`);
      if (
        w.policy.rollout.mode === "canary" &&
        (!w.rollout ||
          typeof w.rollout.promote !== "function" ||
          typeof w.rollout.inspect !== "function")
      )
        fail(
          "invalid_adapter",
          "Canary requires durable promotion and inspection.",
        );
      if (this.workflows.has(w.id))
        fail("invalid_input", "Duplicate workflow ID.");
      this.workflows.set(w.id, w);
      this.definitions.set(
        w.id,
        hash({
          version: w.version,
          optimizer: w.optimizerVersion,
          evaluator: w.evaluatorVersion,
          policy: w.policy,
        }),
      );
    }
  }
  private workflow(key: string) {
    return (
      this.workflows.get(key) ?? fail("not_found", "Workflow not configured.")
    );
  }
  private targetKey(w: ImprovementWorkflow) {
    return `target:${hash(w.policy.target)}`;
  }
  private async read(
    tx: StoreTransaction,
    kind: "runs" | "operations" | "budgets" | "coordination" | "observations",
    key: string,
  ) {
    return this.loop.read(tx, kind, key);
  }
  private async put(
    tx: StoreTransaction,
    kind: "runs" | "operations" | "budgets" | "coordination" | "observations",
    key: string,
    data: unknown,
  ) {
    json(data, 16 * 1024 * 1024);
    const old = await this.read(tx, kind, key),
      now = this.loop.now();
    const row: ControlRecord = {
      id: key,
      namespace: this.loop.namespace,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? now,
      updatedAt: old && old.updatedAt > now ? old.updatedAt : now,
      format: 1,
      data: asJson(clone(data)),
    };
    if (old) await tx.replace(kind, row, old.revision);
    else await tx.insert(kind, row);
    return row;
  }
  private parse(row: ControlRecord): ImprovementRun {
    const d = row.data;
    enumeration(d.state, states, "stored run state");
    nonempty(d.workflowId, "workflowId");
    nonempty(d.definitionHash, "definitionHash");
    nonempty(d.decisionKey, "decisionKey");
    timestamp(d.leaseUntil, "leaseUntil");
    if (d.leaseOwner !== null) nonempty(d.leaseOwner, "leaseOwner");
    integer(d.proposalCalls, "proposalCalls", 0);
    if (!Array.isArray(d.candidateIds))
      fail("integrity_error", "Invalid candidate references.");
    d.candidateIds.forEach((v) => nonempty(v, "candidateId"));
    object(d.comparisons, "comparisons");
    this.baseline(d.baseline);
    return row as unknown as ImprovementRun;
  }
  async getRun(key: string): Promise<ImprovementRun | undefined> {
    return this.loop.store.transaction(this.loop.namespace, async (tx) => {
      const row = await this.read(tx, "runs", key);
      if (!row) return undefined;
      const run = this.parse(row);
      if (
        run.data.decisionKey !==
          hash({
            namespace: this.loop.namespace,
            workflowId: run.data.workflowId,
            definitionHash: run.data.definitionHash,
            baseline: run.data.baseline,
            dataset: run.data.dataset,
          }) ||
        run.id !== `run_${run.data.decisionKey}`
      )
        fail("integrity_error", "Run evidence/baseline identity was altered.");
      const accounting = {
        modelRequests: 0,
        chargedOrReservedTokens: 0,
        deployments: 0,
        outstandingOperations: [] as string[],
      };
      for (const oid of run.data.operationIds ?? []) {
        const op = await this.read(tx, "operations", oid);
        if (!op) fail("integrity_error", "Run operation missing.");
        accounting.modelRequests += Number(op.data.requests ?? 0);
        accounting.chargedOrReservedTokens += Number(
          op.data.chargedTokens ?? op.data.tokens ?? 0,
        );
        if (op.data.status !== "completed")
          accounting.outstandingOperations.push(oid);
      }
      if (await this.read(tx, "operations", `${key}:deployment_budget`))
        accounting.deployments = 1;
      return { ...run, accounting };
    });
  }
  async listRuns(options: PageOptions = {}) {
    const p = await this.loop.list("runs", options);
    return { ...p, items: p.items.map((r) => this.parse(r)) };
  }
  async pause(key: string, reason: string) {
    this.workflow(key);
    nonempty(reason, "reason");
    await this.loop.store.transaction(this.loop.namespace, async (tx) => {
      const old = await this.read(tx, "coordination", `workflow:${key}`);
      await this.put(tx, "coordination", `workflow:${key}`, {
        ...old?.data,
        paused: true,
        reason,
      });
      const now = this.loop.now();
      await tx.insert("events", {
        id: id("event"),
        namespace: this.loop.namespace,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        type: "improvement.administrative_pause",
        subjectId: key,
        details: { reason },
      });
    });
  }
  async resume(key: string) {
    const w = this.workflow(key);
    await this.loop.store.transaction(this.loop.namespace, async (tx) => {
      const old = await this.read(tx, "coordination", `workflow:${key}`);
      await this.put(tx, "coordination", `workflow:${key}`, {
        ...old?.data,
        paused: false,
        reason: "explicit_resume",
      });
      const target = await this.read(tx, "coordination", this.targetKey(w));
      if (target && !target.data.activeRun)
        await this.put(tx, "coordination", this.targetKey(w), {
          ...target.data,
          consecutiveFailures: 0,
        });
      const now = this.loop.now();
      await tx.insert("events", {
        id: id("event"),
        namespace: this.loop.namespace,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        type: "improvement.administrative_resume",
        subjectId: key,
        details: {},
      });
    });
  }
  private async paused(tx: StoreTransaction, w: ImprovementWorkflow) {
    return (
      (await this.read(tx, "coordination", `workflow:${w.id}`))?.data.paused ===
      true
    );
  }
  private baseline(raw: unknown): asserts raw is ArtifactBaseline {
    object(raw, "artifact");
    if (raw.artifactVersion !== null)
      nonempty(raw.artifactVersion, "artifactVersion");
    nonempty(raw.configurationHash, "configurationHash");
  }
  private configuration(w: ImprovementWorkflow) {
    return Object.freeze({
      workflowId: w.id,
      workflowVersion: w.version,
      policyVersion: w.policy.version,
      optimizerVersion: w.optimizerVersion,
      evaluatorVersion: w.evaluatorVersion,
      definitionHash: this.definitions.get(w.id)!,
    });
  }
  private async plain<T>(
    w: ImprovementWorkflow,
    fn: (c: CallbackContext) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return cancellable(
      async (inner) => {
        const value = await fn({
          signal: inner,
          operationId: id("read"),
          configuration: this.configuration(w),
          meter: async () =>
            fail(
              "invalid_adapter",
              "Read-only dataset/artifact callbacks cannot call models.",
            ),
        });
        const clean = await this.loop.prepareControllerPayload(value);
        inner.throwIfAborted();
        return clean;
      },
      signal,
      this.callbackMs,
    );
  }
  private budgetKey(w: ImprovementWorkflow) {
    return `${w.id}:${this.loop.now().slice(0, 10)}`;
  }
  private async budget(w: ImprovementWorkflow) {
    const r = await this.loop.store.transaction(this.loop.namespace, (tx) =>
      this.read(tx, "budgets", this.budgetKey(w)),
    );
    return {
      modelRequests: Number(r?.data.modelRequests ?? 0),
      tokens: Number(r?.data.tokens ?? 0),
      deployments: Number(r?.data.deployments ?? 0),
    };
  }
  private async reserve(
    tx: StoreTransaction,
    w: ImprovementWorkflow,
    requests: number,
    tokens: number,
    deployments = 0,
  ) {
    const key = this.budgetKey(w),
      old = (await this.read(tx, "budgets", key))?.data ?? {};
    const next = {
      modelRequests: Number(old.modelRequests ?? 0) + requests,
      tokens: Number(old.tokens ?? 0) + tokens,
      deployments: Number(old.deployments ?? 0) + deployments,
    };
    for (const k of ["modelRequests", "tokens", "deployments"] as const) {
      integer(next[k], k, 0);
      if (next[k] > w.policy.daily[k])
        fail("budget_exhausted", `Daily ${k} exhausted.`);
    }
    await this.put(tx, "budgets", key, next);
    return key;
  }
  private async owned(
    tx: StoreTransaction,
    runId: string,
    owner: string,
    allowPaused = false,
  ) {
    const row = await this.read(tx, "runs", runId);
    if (!row) fail("not_found", "Run missing.");
    const run = this.parse(row),
      w = this.workflow(run.data.workflowId);
    if (run.data.leaseOwner !== owner || run.data.leaseUntil <= this.loop.now())
      fail("lease_lost", "Run lease lost; late result discarded.");
    if (!allowPaused && (await this.paused(tx, w)))
      fail("paused", "Workflow paused.");
    if (!allowPaused && run.data.definitionHash !== this.definitions.get(w.id))
      fail("policy_changed", "Run configuration changed.");
    if (!allowPaused) {
      const config = (await this.read(tx, "coordination", `workflow:${w.id}`))
        ?.data;
      if (
        config?.definitionHash !== this.definitions.get(w.id) ||
        config?.mode !== (this.options.mode ?? "recommend") ||
        config?.selfImproving !== (this.options.selfImproving ?? false)
      )
        fail(
          "policy_changed",
          "A later invocation changed controller authorization.",
        );
    }
    return run;
  }
  private async save(
    runId: string,
    owner: string,
    patch: Partial<ImprovementRunData>,
    allowPaused = false,
  ) {
    return this.loop.store.transaction(this.loop.namespace, async (tx) => {
      const run = await this.owned(tx, runId, owner, allowPaused),
        data = { ...run.data, ...clone(patch) };
      const row = await this.put(tx, "runs", runId, data);
      const event = {
        id: id("event"),
        namespace: this.loop.namespace,
        revision: 1,
        createdAt: this.loop.now(),
        updatedAt: this.loop.now(),
        type: `improvement.${data.state}`,
        subjectId: runId,
        details: { reason: data.reason },
      };
      await tx.insert("events", event);
      if (terminal.includes(data.state)) {
        const w = this.workflow(data.workflowId),
          key = this.targetKey(w),
          lock = await this.read(tx, "coordination", key);
        if (lock?.data.activeRun === runId) {
          const consecutiveFailures =
            data.state === "completed"
              ? 0
              : Number(lock.data.consecutiveFailures ?? 0) + 1;
          const previousOutcomes = [
            ...((lock.data.previousOutcomes ?? []) as JsonValue[]),
            { state: data.state, reason: data.reason },
          ].slice(-10);
          await this.put(tx, "coordination", key, {
            ...lock.data,
            activeRun: null,
            consecutiveFailures,
            previousOutcomes,
            nextEligibleAt: plus(this.loop.now(), w.policy.cooldownMs),
          });
        }
      }
      return this.parse(row);
    });
  }
  private async operation<T>(
    run: ImprovementRun,
    owner: string,
    kind: string,
    fn: (context: CallbackContext) => Promise<T>,
    signal: AbortSignal,
    allowPaused = false,
  ): Promise<T> {
    const w = this.workflow(run.data.workflowId),
      operationId = `${run.id}:${kind}`;
    let cached: JsonValue | undefined;
    await this.loop.store.transaction(this.loop.namespace, async (tx) => {
      const current = await this.owned(tx, run.id, owner, allowPaused);
      const old = await this.read(tx, "operations", operationId);
      if (old) {
        if (old.data.status === "completed") {
          if (!Object.hasOwn(old.data, "result"))
            fail(
              "integrity_error",
              "Completed callback has no durable result.",
            );
          cached = old.data.result;
          return;
        }
        fail(
          "ambiguous_callback",
          "Callback was dispatched previously; not replayed.",
        );
      }
      await this.put(tx, "operations", operationId, {
        runId: run.id,
        kind,
        status: "pending",
        requests: 0,
        tokens: 0,
        chargedTokens: 0,
      });
      await this.put(tx, "runs", run.id, {
        ...current.data,
        operationIds: [...(current.data.operationIds ?? []), operationId],
      });
    });
    if (cached !== undefined) return clone(cached) as T;
    try {
      const result = await cancellable(
        async (inner) => {
          const context: CallbackContext = {
            operationId,
            signal: inner,
            configuration: this.configuration(w),
            meter: async <TValue>(
              maxTokens: number,
              call: () => Promise<{ value: TValue; tokens: number | null }>,
            ) => {
              integer(maxTokens, "maximum tokens", 0);
              inner.throwIfAborted();
              const day = await this.loop.store.transaction(
                this.loop.namespace,
                async (tx) => {
                  await this.owned(tx, run.id, owner, allowPaused);
                  const op = (await this.read(tx, "operations", operationId))!;
                  const requests = Number(op.data.requests) + 1,
                    tokens = Number(op.data.tokens) + maxTokens;
                  integer(requests, "operation requests");
                  integer(tokens, "operation tokens", 0);
                  integer(op.data.chargedTokens, "charged tokens", 0);
                  if (
                    requests > w.policy.callbackReservation.modelRequests ||
                    tokens > w.policy.callbackReservation.tokens
                  )
                    fail("budget_exhausted", "Callback budget exhausted.");
                  const day = await this.reserve(tx, w, 1, maxTokens);
                  await this.put(tx, "operations", operationId, {
                    ...op.data,
                    requests,
                    tokens,
                    chargedTokens:
                      Number(op.data.chargedTokens ?? 0) + maxTokens,
                  });
                  return day;
                },
              );
              const output = await call();
              inner.throwIfAborted();
              if (output.tokens !== null) {
                integer(output.tokens, "actual tokens", 0);
                await this.loop.store.transaction(
                  this.loop.namespace,
                  async (tx) => {
                    await this.owned(tx, run.id, owner, allowPaused);
                    const b = (await this.read(tx, "budgets", day))!,
                      op = (await this.read(tx, "operations", operationId))!;
                    await this.put(tx, "budgets", day, {
                      ...b.data,
                      tokens:
                        Number(b.data.tokens) - (maxTokens - output.tokens!),
                    });
                    await this.put(tx, "operations", operationId, {
                      ...op.data,
                      chargedTokens:
                        Number(op.data.chargedTokens) -
                        (maxTokens - output.tokens!),
                    });
                  },
                );
              }
              if (output.tokens !== null && output.tokens > maxTokens)
                fail(
                  "budget_contract",
                  "Provider exceeded reserved maximum; actual usage charged and result rejected.",
                );
              return output.value;
            },
          };
          return this.loop.prepareControllerPayload(await fn(context));
        },
        signal,
        this.callbackMs,
      );
      await this.loop.store.transaction(this.loop.namespace, async (tx) => {
        await this.owned(tx, run.id, owner, allowPaused);
        const op = (await this.read(tx, "operations", operationId))!;
        await this.put(tx, "operations", operationId, {
          ...op.data,
          status: "completed",
          result: result as JsonValue,
        });
      });
      return result;
    } catch (error) {
      // Pending stays pending on lost lease/crash/cancellation; never optimistic refund/replay.
      throw error;
    }
  }
  async tick(workflowId: string, signal?: AbortSignal): Promise<TickResult> {
    const w = this.workflow(workflowId),
      mode = this.options.mode ?? "recommend";
    const signal2 = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.tickMs),
    ]);
    const owner = id("worker");
    let run: ImprovementRun | undefined;
    const idle = async (
      reason: string,
      state: RunState = "waiting_for_evidence",
      next?: string,
    ): Promise<TickResult> => ({
      runId: null,
      state,
      reason,
      candidateIds: [],
      budget: await this.budget(w),
      ...(next ? { nextEligibleAt: next } : {}),
    });
    await this.loop.store.transaction(this.loop.namespace, async (tx) => {
      const old = await this.read(tx, "coordination", `workflow:${w.id}`);
      await this.put(tx, "coordination", `workflow:${w.id}`, {
        ...old?.data,
        definitionHash: this.definitions.get(w.id)!,
        mode,
        selfImproving: this.options.selfImproving ?? false,
      });
    });
    const lock = await this.loop.store.transaction(
      this.loop.namespace,
      async (tx) => ({
        target: await this.read(tx, "coordination", this.targetKey(w)),
        paused: await this.paused(tx, w),
      }),
    );
    try {
      if (lock.target?.data.activeRun)
        run = await this.getRun(String(lock.target.data.activeRun));
      if (!run) {
        if (lock.paused) return idle("workflow_paused", "paused");
        if (mode === "autonomous" && this.options.selfImproving !== true)
          return idle("self_improvement_disabled", "paused");
        if (
          Number(lock.target?.data.consecutiveFailures ?? 0) >=
          (w.policy.maximumConsecutiveFailures ?? 3)
        )
          return idle("repeated_failures_require_review", "paused");
        const next = lock.target?.data.nextEligibleAt;
        if (typeof next === "string" && next > this.loop.now())
          return idle("cooldown", "waiting_for_evidence", next);
        const baseline = await this.plain(w, (c) => w.artifact(c), signal2);
        this.baseline(baseline);
        const dataset = prepareDataset(
          await this.plain(w, (c) => w.dataset(c), signal2),
          w.policy,
          this.loop.now(),
        );
        if (mode === "observe") return idle("observation_only");
        if (
          dataset.optimization.length < w.policy.minimumNewUnits ||
          dataset.validation.length < w.policy.minimumValidationUnits ||
          dataset.audit.length < w.policy.minimumAuditUnits
        )
          return idle("insufficient_evidence");
        const definitionHash = this.definitions.get(w.id)!,
          decisionKey = hash({
            namespace: this.loop.namespace,
            workflowId,
            definitionHash,
            baseline,
            dataset,
          });
        const runId = `run_${decisionKey}`;
        const existing = await this.getRun(runId);
        if (existing)
          return {
            runId,
            state: existing.data.state,
            reason: "unchanged_evidence",
            candidateIds: existing.data.candidateIds,
            budget: await this.budget(w),
          };
        run = await this.loop.store.transaction(
          this.loop.namespace,
          async (tx) => {
            const target = await this.read(
              tx,
              "coordination",
              this.targetKey(w),
            );
            if (target?.data.activeRun)
              fail("target_busy", "Target already has an improvement cycle.");
            if (await this.paused(tx, w)) fail("paused", "Workflow paused.");
            const used = new Set((target?.data.usedUnits ?? []) as string[]);
            if (
              dataset.optimization.filter((r) => !used.has(r.entityId)).length <
              w.policy.minimumNewUnits
            )
              fail("insufficient_new_evidence", "Not enough new entities.");
            const d: ImprovementRunData = {
              workflowId,
              definitionHash,
              decisionKey,
              state: "proposing",
              reason: "eligible_evidence",
              baseline,
              dataset,
              candidateIds: [],
              comparisons: {},
              proposalCalls: 0,
              leaseOwner: null,
              leaseUntil: this.loop.now(),
              configuration: this.configuration(w),
              operationIds: [],
              previousOutcomes: (target?.data.previousOutcomes ?? []) as {
                state: string;
                reason: string;
              }[],
            };
            const r = this.parse(await this.put(tx, "runs", runId, d));
            await this.put(tx, "coordination", this.targetKey(w), {
              ...target?.data,
              activeRun: runId,
              usedUnits: [
                ...new Set([
                  ...used,
                  ...dataset.optimization.map((r) => r.entityId),
                ]),
              ],
            });
            return r;
          },
        );
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return idle(
        typeof code === "string"
          ? code
          : signal2.aborted
            ? "cancelled"
            : "callback_failed",
      );
    }
    const rid = run.id;
    // A different workflow may own this target; it must be resumed by its own definition.
    if (run.data.workflowId !== workflowId)
      return idle("target_owned_by_other_workflow");
    try {
      run = await this.loop.store.transaction(
        this.loop.namespace,
        async (tx) => {
          const current = this.parse((await this.read(tx, "runs", rid))!);
          if (
            current.data.leaseOwner &&
            current.data.leaseUntil > this.loop.now()
          )
            fail("run_busy", "Another worker owns this run.");
          return this.parse(
            await this.put(tx, "runs", rid, {
              ...current.data,
              leaseOwner: owner,
              leaseUntil: plus(
                this.loop.now(),
                this.tickMs + this.callbackMs + 60000,
              ),
            }),
          );
        },
      );
      const d = run.data,
        recovering = [
          "deploying",
          "reconciliation_required",
          "rolling_back",
          "observing",
        ].includes(d.state);
      if (recovering && d.selectedId) {
        const candidate = await this.loop.getCandidate(d.selectedId),
          receipt = candidate?.rollbackReceipt;
        if (candidate?.status === "rolled_back" && receipt) {
          const actual = await this.plain(w, (c) => w.artifact(c), signal2);
          this.baseline(actual);
          if (
            actual.artifactVersion !== receipt.artifactVersion ||
            receipt.artifactVersion !== d.baseline.artifactVersion ||
            actual.configurationHash !== d.baseline.configurationHash ||
            receipt.previousArtifactVersion !==
              (d.artifactVersion ??
                candidate.deploymentReceipt?.artifactVersion)
          )
            fail(
              "out_of_band_change",
              "Reviewed rollback does not match actual serving state.",
            );
          run = await this.save(
            rid,
            owner,
            { state: "rolled_back", reason: "reviewed_rollback_confirmed" },
            true,
          );
          return {
            runId: rid,
            state: run.data.state,
            reason: run.data.reason,
            candidateIds: d.candidateIds,
            budget: await this.budget(w),
          };
        }
      }
      if (d.definitionHash !== this.definitions.get(workflowId)) {
        await this.save(
          rid,
          owner,
          { reason: "policy_changed_requires_recovery" },
          true,
        );
        return {
          ...(await idle("policy_changed_requires_recovery", "paused")),
          runId: rid,
          candidateIds: d.candidateIds,
        };
      }
      if (
        (lock.paused ||
          (mode === "autonomous" && this.options.selfImproving !== true)) &&
        !recovering
      ) {
        await this.save(
          rid,
          owner,
          {
            reason: lock.paused
              ? "workflow_paused"
              : "self_improvement_disabled",
          },
          true,
        );
        return {
          ...(await idle(
            lock.paused ? "workflow_paused" : "self_improvement_disabled",
            "paused",
          )),
          runId: rid,
          candidateIds: d.candidateIds,
        };
      }
      signal2.throwIfAborted();
      if (
        d.state === "observing" &&
        d.nextEligibleAt &&
        d.nextEligibleAt > this.loop.now() &&
        Date.parse(this.loop.now()) <
          Date.parse(d.deployedAt!) + w.policy.observation.timeoutMs
      )
        return {
          runId: rid,
          state: d.state,
          reason: d.reason,
          candidateIds: d.candidateIds,
          budget: await this.budget(w),
          nextEligibleAt: d.nextEligibleAt,
        };
      if (d.state === "proposing") {
        const ordinal = d.proposalCalls;
        const proposals = await this.operation(
          run,
          owner,
          `propose:${ordinal}`,
          (c) =>
            w.propose(
              {
                baseline: clone(d.baseline),
                examples: clone(d.dataset.optimization),
                ordinal,
                previousOutcomes: clone(d.previousOutcomes ?? []),
              },
              c,
            ),
          signal2,
        );
        if (
          !Array.isArray(proposals) ||
          proposals.length > (w.policy.maximumCandidates ?? 3)
        )
          fail("proposal_limit", "Invalid/oversized proposal batch.");
        const ids = [...d.candidateIds];
        for (const proposal of proposals) {
          validateChange(proposal, w.policy.changeSchema);
          const candidate = await this.loop.createCandidate({
            id: `candidate_${hash({ runId: rid, proposal })}`,
            target: w.policy.target,
            baseline: d.baseline,
            proposedChange: proposal,
            evidence: {
              decisionKey: d.decisionKey,
              datasetHash: hash(d.dataset),
            },
            risk: "low",
            metadata: { runId: rid, policyVersion: w.policy.version },
          });
          validateChange(candidate.proposedChange, w.policy.changeSchema);
          if (
            hash(candidate.baseline) !== hash(d.baseline) ||
            hash(candidate.target) !== hash(w.policy.target)
          )
            fail("integrity_error", "Sanitizer changed candidate identity.");
          if (!ids.includes(candidate.id)) ids.push(candidate.id);
          if (ids.length > (w.policy.maximumCandidates ?? 3))
            fail("proposal_limit", "Too many candidates.");
        }
        const calls = ordinal + 1,
          done =
            ids.length > 0 || calls >= (w.policy.maximumProposalCalls ?? 3);
        run = await this.save(rid, owner, {
          proposalCalls: calls,
          candidateIds: ids,
          state: done
            ? ids.length
              ? mode === "recommend"
                ? "completed"
                : "evaluating"
              : "no_improvement"
            : "proposing",
          reason:
            mode === "recommend"
              ? "recommendations_only"
              : ids.length
                ? "proposals_ready"
                : "no_proposal",
        });
      } else if (d.state === "evaluating") {
        const comparisons = { ...d.comparisons };
        for (const cid of d.candidateIds) {
          if (comparisons[cid]) continue;
          const candidate = (await this.loop.getCandidate(cid))!;
          const report = await this.operation(
            run,
            owner,
            `validation:${cid}`,
            (c) =>
              w.evaluate(
                {
                  baseline: d.baseline,
                  change: candidate.proposedChange,
                  examples: clone(d.dataset.validation),
                  partition: "validation",
                },
                c,
              ),
            signal2,
          );
          compare(report, d.dataset.validation, w.policy);
          comparisons[cid] = report;
          run = await this.save(rid, owner, {
            comparisons,
            reason: "validation_recorded",
          });
        }
        const ranked = d.candidateIds
          .filter(
            (cid) =>
              compare(comparisons[cid]!, d.dataset.validation, w.policy).passed,
          )
          .sort((a, b) => {
            const x = compare(comparisons[a]!, d.dataset.validation, w.policy),
              y = compare(comparisons[b]!, d.dataset.validation, w.policy);
            return (
              y.improvement - x.improvement ||
              comparisons[a]!.estimatedServingCost -
                comparisons[b]!.estimatedServingCost ||
              a.localeCompare(b)
            );
          });
        if (!ranked.length)
          run = await this.save(rid, owner, {
            state: "no_improvement",
            reason: "validation_failed",
          });
        else
          run = await this.save(rid, owner, {
            selectedId: ranked[0]!,
            state: "selected",
            reason: "winner_selected",
          });
      } else if (d.state === "selected") {
        const cid = d.selectedId!,
          candidate = (await this.loop.getCandidate(cid))!;
        // Audit examples are consumed before first exposure. Global within this namespace.
        await this.loop.store.transaction(this.loop.namespace, async (tx) => {
          await this.owned(tx, rid, owner);
          for (const r of d.dataset.audit) {
            for (const identity of [
              `id:${r.id}`,
              `episode:${r.episodeId}`,
              `entity:${r.entityId}`,
            ]) {
              const key = `audit:${hash(identity)}`,
                prior = await this.read(tx, "coordination", key);
              if (prior && prior.data.runId !== rid)
                fail("audit_consumed", "Fresh audit data required.");
              if (!prior)
                await this.put(tx, "coordination", key, { runId: rid });
            }
          }
        });
        const audit = await this.operation(
          run,
          owner,
          `audit:${cid}`,
          (c) =>
            w.evaluate(
              {
                baseline: d.baseline,
                change: candidate.proposedChange,
                examples: clone(d.dataset.audit),
                partition: "audit",
              },
              c,
            ),
          signal2,
        );
        const gates = compare(audit, d.dataset.audit, w.policy, true);
        const auditMetrics = {
          ...audit.metrics,
          improvement: gates.improvement,
          lowerBound: gates.lower!,
          sampleCount: gates.sampleCount,
        };
        if (candidate.status === "proposed")
          await this.loop.evaluateCandidate(
            cid,
            {
              evaluator: workflowId,
              version: w.evaluatorVersion,
              datasetHash: hash(d.dataset.audit),
              signal: signal2,
            },
            () => ({
              passed: gates.passed,
              metrics: auditMetrics,
              notes: w.policy.auditMethod
                ? `Trusted application audit: ${w.policy.auditMethod.name}@${w.policy.auditMethod.version}`
                : "Fixed-sample paired Hoeffding; independent units required.",
            }),
          );
        const audited = (await this.loop.getCandidate(cid))!;
        const auditEvaluation = audited.evaluations.at(-1);
        if (
          !["evaluated", "approved"].includes(audited.status) ||
          !auditEvaluation ||
          auditEvaluation.evaluator !== workflowId ||
          auditEvaluation.version !== w.evaluatorVersion ||
          auditEvaluation.datasetHash !== hash(d.dataset.audit) ||
          auditEvaluation.baselineHash !== hash(d.baseline) ||
          auditEvaluation.passed !== gates.passed ||
          hash(auditEvaluation.metrics) !== hash(auditMetrics)
        )
          fail(
            "audit_evaluation_conflict",
            "The current evaluation is not this frozen audit. Human changes are not overwritten.",
          );
        run = await this.save(rid, owner, {
          audit,
          auditEvaluationId: auditEvaluation.id,
        });
        if (!gates.passed)
          run = await this.save(rid, owner, {
            audit,
            state: "no_improvement",
            reason: "audit_failed",
          });
        else if (mode !== "autonomous")
          run = await this.save(rid, owner, {
            audit,
            state: "completed",
            reason: "experiment_only",
          });
        else {
          const current = await this.plain(w, (c) => w.artifact(c), signal2);
          this.baseline(current);
          if (hash(current) !== hash(d.baseline))
            fail("stale_baseline", "Serving baseline changed.");
          await this.loop.store.transaction(this.loop.namespace, async (tx) => {
            await this.owned(tx, rid, owner);
            const opId = `${rid}:deployment_budget`;
            if (!(await this.read(tx, "operations", opId))) {
              await this.reserve(tx, w, 0, 0, 1);
              await this.put(tx, "operations", opId, {
                status: "completed",
                result: true,
              });
            }
          });
          const evaluated = (await this.loop.getCandidate(cid))!;
          if (evaluated.status === "evaluated")
            await this.loop.approveCandidate(cid, {
              actor: "loopiter/autonomous",
              evaluationId: auditEvaluation.id,
              authorization: { runId: rid, leaseOwner: owner },
            });
          run = await this.save(rid, owner, {
            audit,
            state: "deploying",
            reason: "audit_passed",
            attemptId: `${rid}:apply`,
            operation: "apply",
          });
        }
      } else if (
        ["deploying", "rolling_back", "reconciliation_required"].includes(
          d.state,
        ) &&
        !d.pendingPromotion
      ) {
        const attemptId = d.attemptId!,
          cid = d.selectedId!;
        const existing = await this.loop.store.transaction(
          this.loop.namespace,
          (tx) => this.loop.read(tx, "attempts", attemptId),
        );
        let attempt;
        if (existing)
          attempt = await this.loop.reconcileAttempt(
            attemptId,
            w.deployment,
            signal2,
          );
        else {
          if (
            d.operation === "apply" &&
            (this.options.selfImproving !== true ||
              mode !== "autonomous" ||
              lock.paused)
          )
            return {
              ...(await idle("self_improvement_disabled", "paused")),
              runId: rid,
              candidateIds: d.candidateIds,
            };
          const current = await this.plain(w, (c) => w.artifact(c), signal2);
          this.baseline(current);
          if (d.operation === "apply" && hash(current) !== hash(d.baseline))
            fail("stale_baseline", "Target changed before dispatch.");
          if (
            d.operation === "rollback" &&
            (current.artifactVersion !== d.artifactVersion ||
              current.configurationHash !== d.observationConfigurationHash)
          )
            fail(
              "out_of_band_change",
              "Will not roll back an unrelated configuration.",
            );
          // Check durable authorization immediately before the adapter dispatch, after
          // the core has persisted its attempt. Failed authorization is inspect-only.
          const adapter = {
            inspect: w.deployment.inspect.bind(w.deployment),
            rollback: w.deployment.rollback.bind(w.deployment),
            apply: async (
              request: import("./contracts.js").DeploymentRequest,
            ) => {
              await this.loop.store.transaction(this.loop.namespace, (tx) =>
                this.owned(tx, rid, owner),
              );
              return w.deployment.apply(request);
            },
          };
          attempt =
            d.operation === "rollback"
              ? await this.loop.rollbackCandidate(cid, {
                  adapter,
                  attemptId,
                  signal: signal2,
                  expectedArtifactVersion: d.artifactVersion!,
                })
              : await this.loop.deployCandidate(cid, {
                  adapter,
                  attemptId,
                  signal: signal2,
                  expectedArtifactVersion: d.baseline.artifactVersion,
                  authorization: { runId: rid, leaseOwner: owner },
                });
        }
        if (attempt.status === "pending")
          run = await this.save(
            rid,
            owner,
            { state: "reconciliation_required", reason: "deployment_unknown" },
            true,
          );
        else if (attempt.status === "not_applied")
          run = await this.save(
            rid,
            owner,
            {
              state:
                d.operation === "rollback"
                  ? "reconciliation_required"
                  : "failed",
              reason: "operation_fenced_not_applied",
            },
            true,
          );
        else if (d.operation === "rollback")
          run = await this.save(
            rid,
            owner,
            { state: "rolled_back", reason: "previous_version_restored" },
            true,
          );
        else {
          const actual = await this.plain(w, (c) => w.artifact(c), signal2);
          this.baseline(actual);
          if (
            actual.artifactVersion !== attempt.receipt!.artifactVersion ||
            actual.configurationHash !== d.baseline.configurationHash
          )
            fail(
              "out_of_band_change",
              "Applied version or pinned execution context changed.",
            );
          run = await this.save(
            rid,
            owner,
            {
              state: "observing",
              reason: "deployment_is_not_improvement",
              artifactVersion: attempt.receipt!.artifactVersion!,
              observationConfigurationHash: actual.configurationHash,
              deployedAt: attempt.updatedAt,
            },
            true,
          );
        }
      } else if (d.state === "observing" || d.pendingPromotion) {
        const actual = await this.plain(w, (c) => w.artifact(c), signal2);
        this.baseline(actual);
        if (
          actual.artifactVersion !== d.artifactVersion ||
          actual.configurationHash !== d.observationConfigurationHash
        )
          fail(
            "out_of_band_change",
            "Serving configuration changed during observation.",
          );
        const promotion = await this.loop.store.transaction(
          this.loop.namespace,
          (tx) => this.read(tx, "operations", `${rid}:promote`),
        );
        if (promotion) {
          const status = await this.plain(
            w,
            (c) =>
              w.rollout!.inspect(
                {
                  operationId: `${rid}:promote`,
                  artifactVersion: d.artifactVersion!,
                },
                c,
              ),
            signal2,
          );
          enumeration(
            status,
            ["promoted", "unknown", "not_applied"],
            "promotion inspection",
          );
          run = await this.save(
            rid,
            owner,
            status === "promoted"
              ? {
                  state: "completed",
                  reason: "canary_promoted",
                  pendingPromotion: false,
                }
              : status === "not_applied"
                ? {
                    state: "rolling_back",
                    operation: "rollback",
                    attemptId: `${rid}:rollback`,
                    reason: "promotion_fenced_withdraw",
                    pendingPromotion: false,
                  }
                : {
                    state: "reconciliation_required",
                    reason: "promotion_requires_reconciliation",
                    pendingPromotion: true,
                  },
            true,
          );
          return {
            runId: rid,
            state: run.data.state,
            reason: run.data.reason,
            candidateIds: d.candidateIds,
            budget: await this.budget(w),
          };
        }
        if (d.pendingPromotion) {
          run = await this.save(
            rid,
            owner,
            {
              state: "observing",
              pendingPromotion: false,
              reason: "promotion_not_dispatched",
            },
            true,
          );
          return {
            runId: rid,
            state: run.data.state,
            reason: run.data.reason,
            candidateIds: d.candidateIds,
            budget: await this.budget(w),
          };
        }
        if (
          Date.parse(this.loop.now()) >=
          Date.parse(d.deployedAt!) + w.policy.observation.timeoutMs
        ) {
          run = await this.save(
            rid,
            owner,
            {
              state: "rolling_back",
              operation: "rollback",
              attemptId: `${rid}:rollback`,
              reason: "observation_timeout",
            },
            true,
          );
        } else {
          const observed = await this.operation(
            run,
            owner,
            `observe:${run.revision}`,
            (c) =>
              w.observe(
                {
                  runId: rid,
                  artifactVersion: d.artifactVersion!,
                  baseline: d.baseline,
                  deployedAt: d.deployedAt!,
                },
                c,
              ),
            signal2,
            true,
          );
          this.validateObservation(observed, run, w);
          if (w.policy.rollout.mode === "canary")
            run = await this.save(
              rid,
              owner,
              { assignmentHash: observed.assignmentHash! },
              true,
            );
          const oid = `${rid}:observation:${run.revision}`;
          await this.loop.store.transaction(this.loop.namespace, async (tx) => {
            await this.owned(tx, rid, owner, true);
            if (!(await this.read(tx, "observations", oid)))
              await this.put(tx, "observations", oid, observed);
          });
          const enough =
            observed.complete &&
            observed.unitIds.length >= w.policy.observation.minimumUnits &&
            Date.parse(observed.endedAt) - Date.parse(d.deployedAt!) >=
              w.policy.observation.minimumDurationMs;
          const passed = passesGates(
            observed.metrics,
            w.policy.observation.guardrails,
          );
          if (
            !passed &&
            observed.complete &&
            observed.unitIds.length >= w.policy.observation.minimumUnits
          )
            run = await this.save(
              rid,
              owner,
              {
                state: "rolling_back",
                operation: "rollback",
                attemptId: `${rid}:rollback`,
                reason: "production_guardrail_failed",
                lastObservationId: oid,
              },
              true,
            );
          else if (enough && passed) {
            if (w.policy.rollout.mode === "canary") {
              if (
                observed.improvementLowerBound! <=
                w.policy.objective.minimumImprovement
              ) {
                await this.save(
                  rid,
                  owner,
                  { reason: "canary_not_superior", lastObservationId: oid },
                  true,
                );
                return {
                  ...(await idle("canary_not_superior", "observing")),
                  runId: rid,
                  candidateIds: d.candidateIds,
                };
              }
              if (
                lock.paused ||
                this.options.selfImproving !== true ||
                mode !== "autonomous"
              )
                return {
                  ...(await idle("promotion_paused", "paused")),
                  runId: rid,
                  candidateIds: d.candidateIds,
                };
              run = await this.save(rid, owner, {
                pendingPromotion: true,
                reason: "promotion_dispatch_pending",
                lastObservationId: oid,
              });
              await this.operation(
                run,
                owner,
                "promote",
                async (c) => {
                  await w.rollout!.promote(
                    {
                      operationId: c.operationId,
                      artifactVersion: d.artifactVersion!,
                      baseline: d.baseline,
                    },
                    c,
                  );
                  return true;
                },
                signal2,
              );
            }
            run = await this.save(
              rid,
              owner,
              {
                state: "completed",
                reason:
                  w.policy.rollout.mode === "immediate"
                    ? "offline_pass_and_production_limits_met_not_causal_proof"
                    : "canary_promoted",
                lastObservationId: oid,
              },
              true,
            );
          } else
            run = await this.save(
              rid,
              owner,
              {
                reason: "waiting_for_mature_outcomes",
                lastObservationId: oid,
                nextEligibleAt: plus(
                  this.loop.now(),
                  Math.min(60000, w.policy.observation.timeoutMs),
                ),
              },
              true,
            );
        }
      }
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code,
        code =
          typeof rawCode === "string"
            ? rawCode
            : signal2.aborted
              ? "cancelled"
              : "callback_failed";
      if (code === "run_busy")
        return {
          ...(await idle(code)),
          runId: rid,
          candidateIds: run?.data.candidateIds ?? [],
        };
      if (code !== "lease_lost") {
        const current = await this.getRun(rid);
        if (current?.data.leaseOwner === owner) {
          const recovery =
            current.data.pendingPromotion ||
            ["deploying", "rolling_back", "reconciliation_required"].includes(
              current.data.state,
            );
          const pause = ["paused", "policy_changed"].includes(code);
          // Observation failure must never restart the deployment/observation clock.
          run = await this.save(
            rid,
            owner,
            {
              state: recovery
                ? "reconciliation_required"
                : pause || current.data.state === "observing"
                  ? current.data.state
                  : "failed",
              reason: code,
            },
            true,
          ).catch(() => current);
        }
      }
    } finally {
      await this.loop.store.transaction(this.loop.namespace, async (tx) => {
        const r = await this.read(tx, "runs", rid);
        if (r?.data.leaseOwner === owner)
          await this.put(tx, "runs", rid, {
            ...r.data,
            leaseOwner: null,
            leaseUntil: this.loop.now(),
          });
      });
    }
    run = await this.getRun(rid);
    return {
      runId: rid,
      state: run!.data.state,
      reason: run!.data.reason,
      candidateIds: run!.data.candidateIds,
      budget: await this.budget(w),
      ...(run!.data.nextEligibleAt
        ? { nextEligibleAt: run!.data.nextEligibleAt }
        : {}),
    };
  }
  private validateObservation(
    o: Observation,
    run: ImprovementRun,
    w: ImprovementWorkflow,
  ) {
    json(o, 16 * 1024 * 1024);
    this.baseline(o);
    timestamp(o.startedAt, "observation start");
    timestamp(o.endedAt, "observation end");
    if (
      o.artifactVersion !== run.data.artifactVersion ||
      o.configurationHash !== run.data.observationConfigurationHash ||
      Date.parse(o.startedAt) !== Date.parse(run.data.deployedAt!) ||
      Date.parse(o.endedAt) > Date.parse(this.loop.now()) ||
      Date.parse(o.endedAt) < Date.parse(o.startedAt)
    )
      fail("invalid_observation", "Observation identity/window mismatch.");
    if (
      typeof o.complete !== "boolean" ||
      !Array.isArray(o.unitIds) ||
      new Set(o.unitIds).size !== o.unitIds.length
    )
      fail("invalid_observation", "Invalid observation units.");
    o.unitIds.forEach((s) => nonempty(s, "observation unit"));
    passesGates(o.metrics, w.policy.observation.guardrails);
    if (w.policy.rollout.mode === "canary") {
      if (o.controlVersion !== run.data.baseline.artifactVersion)
        fail("invalid_observation", "Canary control mismatch.");
      nonempty(o.assignmentHash, "assignmentHash");
      if (
        typeof o.improvementLowerBound !== "number" ||
        !Number.isFinite(o.improvementLowerBound)
      )
        fail("invalid_observation", "Canary uncertainty bound required.");
      if (
        run.data.assignmentHash &&
        o.assignmentHash !== run.data.assignmentHash
      )
        fail("invalid_observation", "Cohort assignment definition changed.");
      const width = w.policy.objective.range[1] - w.policy.objective.range[0];
      if (o.improvementLowerBound! < -width || o.improvementLowerBound! > width)
        fail("invalid_observation", "Canary bound outside objective range.");
      if (
        !Array.isArray(o.controlUnitIds) ||
        new Set(o.controlUnitIds).size !== o.controlUnitIds.length ||
        o.controlUnitIds.length < w.policy.observation.minimumUnits
      )
        fail(
          "invalid_observation",
          "Independent mature control units required.",
        );
      const candidateUnits = new Set(o.unitIds);
      o.controlUnitIds.forEach((unit) => {
        nonempty(unit, "control unit");
        if (candidateUnits.has(unit))
          fail("invalid_observation", "Canary/control units overlap.");
      });
    }
  }
}
