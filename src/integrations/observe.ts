import { randomUUID } from "node:crypto";
import type { AiExecution, ExecutionKind, JsonObject, JsonValue } from "../contracts.js";
import type { FeedbackLoop } from "../feedback-loop.js";
import { captureJson } from "./capture.js";
import { capturePayload, type CapturePolicy } from "./privacy.js";
export { capturePayload, redactCapture, type CapturePolicy } from "./privacy.js";

/** Set from authenticated application state, never directly from an end-user form. */
export interface ApplicationContext {
  tenantId?: string;
  productId?: string;
  policyVersion?: string;
  locale?: string;
  asOf?: string;
}
export interface ObservationContext {
  id?: string;
  episodeId?: string;
  parentExecutionId?: string;
  entityId?: string;
  releaseId?: string;
  traceId?: string;
  spanId?: string;
  learningContext?: ApplicationContext;
}
/** Opt-in background writes. The default observer still awaits the store. */
export interface BoundedCaptureOptions {
  /** Outstanding writes, including the one in flight. One observation needs two. */
  queueLimit: number;
  /** Counted failed at this point. The slot stays until the store call settles. */
  writeTimeoutMs: number;
  /** forceFlush and shutdown stop after this. Queued writes are then dropped. */
  shutdownTimeoutMs?: number;
}
export interface DefaultObserver {
  observe<T>(name: string, operation: () => T | Promise<T>, input?: {
    context?: ObservationContext; kind?: ExecutionKind; input?: JsonValue;
  }): Promise<T>;
}
export interface BoundedObserver extends DefaultObserver {
  stats(): CaptureCounters;
  forceFlush(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}
export interface CaptureCounters {
  dropped: number;
  failed: number;
  /** Writes waiting or in flight. */
  backlog: number;
}
export interface ObserverOptions {
  loop: FeedbackLoop;
  capture?: CapturePolicy;
  /** Telemetry failure never causes the operation to be retried. Defaults to open. */
  failureMode?: "open" | "closed";
  onError?: (error: unknown) => void;
  /**
   * Background capture. Omitted means the request awaits each store write.
   * Cannot be combined with `failureMode: "closed"`.
   * A durable `context.id` is not claimed before the function runs.
   * The observation is queued only when both the record and its completion fit.
   */
  bounded?: BoundedCaptureOptions;
}

/** Async application/tool/retrieval observation. Does not install a tracing provider. */
export function createObserver(options: ObserverOptions & { bounded: BoundedCaptureOptions }): BoundedObserver;
export function createObserver(options: ObserverOptions): DefaultObserver;
export function createObserver(options: ObserverOptions): DefaultObserver | BoundedObserver {
  const policy = { mode: "metadata-only" as const, ...options.capture };
  capturePayload(null, policy);
  if (options.bounded) return createBoundedObserver(options, policy);
  async function persist<T>(action: () => Promise<T>): Promise<T | undefined> {
    try { return await action(); } catch (error) {
      try { options.onError?.(error); } catch { /* telemetry callbacks cannot retry business work */ }
      if (options.failureMode === "closed") throw error;
      return undefined;
    }
  }
  return {
    async observe<T>(name: string, operation: () => T | Promise<T>, input: {
      context?: ObservationContext; kind?: ExecutionKind; input?: JsonValue;
    } = {}): Promise<T> {
      if (!name.trim() || name.length > 200) throw new TypeError("Observation name must be 1–200 characters.");
      const context = structuredClone(input.context ?? {});
      const attemptId = randomUUID();
      let row: AiExecution | undefined;
      // A caller-supplied durable ID requires reliable claiming even in fail-open mode.
      const begin = async () => {
        if (context.id && await options.loop.getExecution(context.id))
          throw new Error("Observation already exists; inspect the original result instead of replaying.");
        const captured = capturePayload(input.input ?? null, policy);
        return options.loop.recordExecution({
          id: context.id ?? `observe_${attemptId}`, kind: input.kind ?? "workflow",
          ...(context.episodeId ? { episodeId: context.episodeId } : {}),
          ...(context.entityId ? { entityId: context.entityId } : {}),
          ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
          input: captured.value,
          artifacts: context.releaseId ? { prompt: context.releaseId } : {},
          metadata: { ...captureJson(context) as JsonObject, observation: name, observeOnly: true,
            loopiterCapture: { attemptId, status: "pending", mode: policy.mode, truncated: captured.truncated, replayEligible: false } },
        });
      };
      row = context.id ? await begin() : await persist(begin);
      // Reusing an execution ID cannot cause an already recorded application call to run again.
      if (row && (row.metadata.loopiterCapture as JsonObject)?.attemptId !== attemptId)
        throw new Error("Observation already exists; inspect the original application result instead of replaying.");
      let finished = false;
      const finish = async (status: string, value: unknown = null) => {
        if (finished) return;
        finished = true;
        if (!row) return;
        await persist(async () => {
          const captured = capturePayload(policy.mode === "metadata-only" ? null : captureJson(value), policy);
          await options.loop.completeExecution(row!.id, { output: captured.value, metadata: {
            loopiterCapture: { ...(row!.metadata.loopiterCapture as JsonObject), status,
              truncated: captured.truncated || (row!.metadata.loopiterCapture as JsonObject).truncated === true,
              replayEligible: false },
          } }, row!.revision);
        });
      };
      let result: T;
      try { result = await operation(); } catch (error) {
        // Always preserve the business error even if persistence also fails.
        try { await finish("failed"); } catch { /* original error wins */ }
        throw error;
      }
      if (result && typeof (result as any)[Symbol.asyncIterator] === "function") {
        const source = result as unknown as AsyncIterable<unknown>;
        const wrapped = (async function* () {
          let ended = false, failed = false, chunks = 0;
          try {
            for await (const chunk of source) { chunks++; yield chunk; }
            ended = true;
          } catch (error) { failed = true; throw error; }
          finally {
            // Never buffer streaming payloads or consume ahead of the caller.
            if (failed) { try { await finish("failed", { chunks }); } catch {} }
            else await finish(ended ? "completed" : "cancelled", { chunks });
          }
        })();
        return wrapped as T;
      }
      await finish("completed", result === undefined ? null : result);
      return result;
    },
  };
}

function createBoundedObserver(options: ObserverOptions, policy: CapturePolicy): BoundedObserver {
  const bounded = options.bounded!;
  if (options.failureMode === "closed")
    throw new TypeError("failureMode closed cannot be combined with bounded capture.");
  if (!Number.isInteger(bounded.queueLimit) || bounded.queueLimit < 1)
    throw new TypeError("queueLimit must be a positive integer.");
  if (!Number.isInteger(bounded.writeTimeoutMs) || bounded.writeTimeoutMs < 1)
    throw new TypeError("writeTimeoutMs must be a positive integer.");
  const shutdownTimeoutMs = bounded.shutdownTimeoutMs ?? bounded.writeTimeoutMs;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1)
    throw new TypeError("shutdownTimeoutMs must be a positive integer.");
  const queue: Array<(timedOut: () => boolean) => Promise<void>> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let active = 0;
  let reserved = 0;
  let dropped = 0;
  let failed = 0;
  let closed = false;
  let generation = 0;
  let activeDeadline = false;
  const note = (error: unknown) => {
    try { options.onError?.(error); } catch { /* telemetry callbacks cannot retry business work */ }
  };
  const dropError = () => new Error("Capture write dropped. The record was not stored and will not be replayed.");
  const occupancy = () => queue.length + active + reserved;
  function pump() {
    if (active > 0 || queue.length === 0) return;
    const task = queue.shift()!;
    const token = generation;
    active += 1;
    activeDeadline = false;
    let deadlineHit = false;
    const timer = setTimeout(() => {
      if (token !== generation || deadlineHit) return;
      deadlineHit = true;
      activeDeadline = true;
      failed += 1;
      note(new Error("Capture write deadline exceeded."));
    }, bounded.writeTimeoutMs);
    timers.add(timer);
    void task(() => deadlineHit).then(() => undefined, () => undefined).finally(() => {
      clearTimeout(timer);
      timers.delete(timer);
      if (token !== generation) return;
      active -= 1;
      activeDeadline = false;
      pump();
    });
  }
  function enqueue(task: (timedOut: () => boolean) => Promise<void>) {
    if (closed) return;
    queue.push(task);
    pump();
  }
  function abandon() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const inflight = active > 0 && !activeDeadline ? 1 : 0;
    const count = queue.length + inflight;
    dropped += count;
    for (let i = 0; i < count; i++) note(dropError());
    queue.length = 0;
    active = 0;
    reserved = 0;
    activeDeadline = false;
    generation += 1;
  }
  async function forceFlush(timeoutMs = shutdownTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (occupancy() > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (occupancy() > 0) abandon();
  }
  return {
    stats: () => ({ dropped, failed, backlog: occupancy() }),
    forceFlush,
    shutdown(timeoutMs = shutdownTimeoutMs) {
      closed = true;
      return forceFlush(timeoutMs);
    },
    async observe<T>(name: string, operation: () => T | Promise<T>, input: {
      context?: ObservationContext; kind?: ExecutionKind; input?: JsonValue;
    } = {}): Promise<T> {
      if (!name.trim() || name.length > 200) throw new TypeError("Observation name must be 1–200 characters.");
      const context = structuredClone(input.context ?? {});
      const attemptId = randomUUID();
      let row: AiExecution | undefined;
      let late = false;
      const ticket = generation;
      const stale = () => closed || generation !== ticket;
      const admitted = !stale() && occupancy() + 2 <= bounded.queueLimit;
      let held = admitted;
      if (!admitted) {
        dropped += 1;
        note(dropError());
      } else reserved += 1;
      function releaseReservation() {
        if (!held) return;
        held = false;
        if (stale()) return;
        reserved -= 1;
        if (reserved < 0) throw new Error("Capture reservation went negative.");
      }
      const closeLate = async (recorded: AiExecution) => {
        if (stale()) return;
        late = true;
        const captured = capturePayload(null, policy);
        await options.loop.completeExecution(recorded.id, { output: captured.value, metadata: {
          loopiterCapture: { ...(recorded.metadata.loopiterCapture as JsonObject), status: "failed",
            truncated: (recorded.metadata.loopiterCapture as JsonObject).truncated === true, replayEligible: false },
        } }, recorded.revision);
      };
      if (admitted) enqueue(async (timedOut) => {
        try {
          if (context.id && await options.loop.getExecution(context.id))
            throw new Error("Observation already exists; inspect the original result instead of replaying.");
          if (stale()) return;
          const captured = capturePayload(input.input ?? null, policy);
          const recorded = await options.loop.recordExecution({
            id: context.id ?? `observe_${attemptId}`, kind: input.kind ?? "workflow",
            ...(context.episodeId ? { episodeId: context.episodeId } : {}),
            ...(context.entityId ? { entityId: context.entityId } : {}),
            ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
            input: captured.value,
            artifacts: context.releaseId ? { prompt: context.releaseId } : {},
            metadata: { ...captureJson(context) as JsonObject, observation: name, observeOnly: true,
              loopiterCapture: { attemptId, status: "pending", mode: policy.mode, truncated: captured.truncated, replayEligible: false } },
          });
          if (stale()) return;
          if ((recorded.metadata.loopiterCapture as JsonObject)?.attemptId !== attemptId)
            throw new Error("Observation already exists; inspect the original result instead of replaying.");
          if (timedOut()) {
            await closeLate(recorded);
            return;
          }
          if (stale()) return;
          row = recorded;
        } catch (error) {
          if (!timedOut() && !stale()) {
            failed += 1;
            note(error);
          }
        }
      });
      const finish = (status: string, value: unknown = null) => {
        if (!admitted || !held) return;
        if (stale()) {
          held = false;
          return;
        }
        releaseReservation();
        if (stale()) return;
        enqueue(async (timedOut) => {
          if (stale() || !row || late) return;
          try {
            const captured = capturePayload(policy.mode === "metadata-only" ? null : captureJson(value), policy);
            await options.loop.completeExecution(row.id, { output: captured.value, metadata: {
              loopiterCapture: { ...(row.metadata.loopiterCapture as JsonObject), status,
                truncated: captured.truncated || (row.metadata.loopiterCapture as JsonObject).truncated === true,
                replayEligible: false },
            } }, row.revision);
            if (stale() || timedOut()) return;
          } catch (error) {
            if (!timedOut() && !stale()) {
              failed += 1;
              note(error);
            }
          }
        });
      };
      let result: T;
      try { result = await operation(); } catch (error) {
        finish("failed");
        throw error;
      }
      if (result && typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
        const source = result as unknown as AsyncIterable<unknown>;
        const wrapped = (async function* () {
          let ended = false, failedStream = false, chunks = 0;
          try {
            for await (const chunk of source) { chunks++; yield chunk; }
            ended = true;
          } catch (error) { failedStream = true; throw error; }
          finally { finish(failedStream ? "failed" : ended ? "completed" : "cancelled", { chunks }); }
        })();
        return wrapped as T;
      }
      finish("completed", result === undefined ? null : result);
      return result;
    },
  };
}
