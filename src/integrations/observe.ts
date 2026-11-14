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
  /** Outstanding writes, including the one in flight. */
  queueLimit: number;
  /** A write past this is counted failed and the next write may start. */
  writeTimeoutMs: number;
  /** Flush and shutdown stop after this. The rest of the queue is dropped. */
  shutdownTimeoutMs?: number;
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
   * A durable `context.id` is not claimed before the function runs: the business
   * call always proceeds, and a conflicting id fails the queued write.
   * Dropped and failed records are not stored and are not replayed.
   */
  bounded?: BoundedCaptureOptions;
}

/** Async application/tool/retrieval observation. Does not install a tracing provider. */
export function createObserver(options: ObserverOptions) {
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

function createBoundedObserver(options: ObserverOptions, policy: CapturePolicy) {
  const bounded = options.bounded!;
  if (!Number.isInteger(bounded.queueLimit) || bounded.queueLimit < 1)
    throw new TypeError("queueLimit must be a positive integer.");
  if (!Number.isInteger(bounded.writeTimeoutMs) || bounded.writeTimeoutMs < 1)
    throw new TypeError("writeTimeoutMs must be a positive integer.");
  const shutdownTimeoutMs = bounded.shutdownTimeoutMs ?? bounded.writeTimeoutMs;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1)
    throw new TypeError("shutdownTimeoutMs must be a positive integer.");
  const queue: Array<() => Promise<void>> = [];
  let active = 0;
  let dropped = 0;
  let failed = 0;
  let closed = false;
  let generation = 0;
  const note = (error: unknown) => {
    try { options.onError?.(error); } catch { /* telemetry callbacks cannot retry business work */ }
  };
  const backlog = () => queue.length + active;
  function pump() {
    if (active > 0 || queue.length === 0) return;
    const task = queue.shift()!;
    const token = generation;
    active += 1;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || token !== generation) return;
      settled = true;
      failed += 1;
      note(new Error("Capture write deadline exceeded."));
      active -= 1;
      pump();
    }, bounded.writeTimeoutMs);
    void task().then(() => {
      if (settled || token !== generation) return;
      settled = true;
      clearTimeout(timer);
      active -= 1;
      pump();
    }, (error) => {
      if (settled || token !== generation) return;
      settled = true;
      clearTimeout(timer);
      failed += 1;
      note(error);
      active -= 1;
      pump();
    });
  }
  function enqueue(task: () => Promise<void>) {
    if (closed || queue.length + active >= bounded.queueLimit) {
      dropped += 1;
      return;
    }
    queue.push(task);
    pump();
  }
  function abandon() {
    dropped += queue.length + active;
    queue.length = 0;
    active = 0;
    generation += 1;
  }
  async function flush(timeoutMs = shutdownTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while ((queue.length > 0 || active > 0) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (queue.length > 0 || active > 0) abandon();
  }
  return {
    stats(): CaptureCounters {
      return { dropped, failed, backlog: backlog() };
    },
    flush,
    shutdown(timeoutMs = shutdownTimeoutMs) {
      closed = true;
      return flush(timeoutMs);
    },
    async observe<T>(name: string, operation: () => T | Promise<T>, input: {
      context?: ObservationContext; kind?: ExecutionKind; input?: JsonValue;
    } = {}): Promise<T> {
      if (!name.trim() || name.length > 200) throw new TypeError("Observation name must be 1–200 characters.");
      const context = structuredClone(input.context ?? {});
      const attemptId = randomUUID();
      let row: AiExecution | undefined;
      enqueue(async () => {
        if (context.id && await options.loop.getExecution(context.id))
          throw new Error("Observation already exists; inspect the original result instead of replaying.");
        const captured = capturePayload(input.input ?? null, policy);
        row = await options.loop.recordExecution({
          id: context.id ?? `observe_${attemptId}`, kind: input.kind ?? "workflow",
          ...(context.episodeId ? { episodeId: context.episodeId } : {}),
          ...(context.entityId ? { entityId: context.entityId } : {}),
          ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
          input: captured.value,
          artifacts: context.releaseId ? { prompt: context.releaseId } : {},
          metadata: { ...captureJson(context) as JsonObject, observation: name, observeOnly: true,
            loopiterCapture: { attemptId, status: "pending", mode: policy.mode, truncated: captured.truncated, replayEligible: false } },
        });
      });
      const finish = (status: string, value: unknown = null) => {
        enqueue(async () => {
          if (!row) return;
          const captured = capturePayload(policy.mode === "metadata-only" ? null : captureJson(value), policy);
          await options.loop.completeExecution(row.id, { output: captured.value, metadata: {
            loopiterCapture: { ...(row.metadata.loopiterCapture as JsonObject), status,
              truncated: captured.truncated || (row.metadata.loopiterCapture as JsonObject).truncated === true,
              replayEligible: false },
          } }, row.revision);
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
