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
export interface ObserverOptions {
  loop: FeedbackLoop;
  capture?: CapturePolicy;
  /** Telemetry failure never causes the operation to be retried. Defaults to open. */
  failureMode?: "open" | "closed";
  onError?: (error: unknown) => void;
}

/** Async application/tool/retrieval observation. Does not install a tracing provider. */
export function createObserver(options: ObserverOptions) {
  const policy = { mode: "metadata-only" as const, ...options.capture };
  capturePayload(null, policy);
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
