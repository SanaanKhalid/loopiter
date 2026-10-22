import { createHash } from "node:crypto";
import type { FeedbackLoop } from "../feedback-loop.js";
import type { JsonObject } from "../contracts.js";
import { captureJson } from "./capture.js";
import { capturePayload, type CapturePolicy } from "./privacy.js";
import type { ObservationContext } from "./observe.js";

/** Structural subset of OTel ReadableSpan; no second SDK/provider is installed. */
export interface ReadableSpan {
  name: string;
  spanContext(): { traceId: string; spanId: string };
  parentSpanContext?: { spanId: string };
  startTime: readonly [number, number];
  endTime: readonly [number, number];
  status: { code: number };
  attributes: Readonly<Record<string, unknown>>;
}
const stamp = (time: readonly [number, number]) => new Date(time[0] * 1000 + time[1] / 1e6).toISOString();
export const spanExecutionId = (traceId: string, spanId: string) =>
  "otel_" + createHash("sha256").update(`${traceId}:${spanId}`).digest("hex");

export function createLoopiterSpanExporter(options: {
  loop: FeedbackLoop;
  capture?: CapturePolicy;
  /** Application-controlled mapping; never trust arbitrary span attributes as authorization. */
  context?: (span: ReadableSpan) => ObservationContext;
  select?: (span: ReadableSpan) => boolean;
}) {
  const policy = { mode: "metadata-only" as const, ...options.capture };
  capturePayload(null, policy);
  const pending = new Set<Promise<void>>();
  let closed = false;
  return {
    export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
      if (closed) { callback({ code: 1, error: new Error("Exporter is shut down.") }); return; }
      const work = (async () => {
        for (const span of spans) {
          if (options.select && !options.select(span)) continue;
          const { traceId, spanId } = span.spanContext();
          if (!/^[a-f0-9]{32}$/i.test(traceId) || !/^[a-f0-9]{16}$/i.test(spanId) || /^0+$/.test(traceId) || /^0+$/.test(spanId))
            throw new TypeError("Invalid OTel trace/span identity.");
          const context = options.context?.(span) ?? {};
          const a = span.attributes;
          const input = capturePayload(policy.mode === "metadata-only" ? null : captureJson(a["gen_ai.input.messages"] ?? null), policy);
          const output = capturePayload(policy.mode === "metadata-only" ? null : captureJson(a["gen_ai.output.messages"] ?? null), policy);
          await options.loop.recordExecution({
            id: spanExecutionId(traceId, spanId), kind: a["gen_ai.request.model"] ? "inference" : "custom",
            ...(context.episodeId ? { episodeId: context.episodeId } : {}),
            ...(context.entityId ? { entityId: context.entityId } : {}),
            input: input.value, output: output.value,
            startedAt: stamp(span.startTime), completedAt: stamp(span.endTime),
            artifacts: { ...(typeof a["gen_ai.request.model"] === "string" ? { model: a["gen_ai.request.model"] } : {}), ...(context.releaseId ? { prompt: context.releaseId } : {}) },
            metadata: {
              ...captureJson(context) as JsonObject, traceId, spanId, observeOnly: true,
              ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId, parentExecutionId: spanExecutionId(traceId, span.parentSpanContext.spanId) } : {}),
              loopiterCapture: { integration: "opentelemetry", mode: policy.mode,
                // Ending a span does not prove task success, especially UNSET status.
                status: span.status.code === 2 ? "failed" : span.status.code === 1 ? "completed" : "unknown",
                truncated: input.truncated || output.truncated, replayEligible: false },
              // Deliberate allowlist: arbitrary attributes/events may contain credentials or PII.
              ...(typeof a["gen_ai.usage.input_tokens"] === "number" && Number.isFinite(a["gen_ai.usage.input_tokens"]) && a["gen_ai.usage.input_tokens"] >= 0 ? { inputTokens: a["gen_ai.usage.input_tokens"] } : {}),
              ...(typeof a["gen_ai.usage.output_tokens"] === "number" && Number.isFinite(a["gen_ai.usage.output_tokens"]) && a["gen_ai.usage.output_tokens"] >= 0 ? { outputTokens: a["gen_ai.usage.output_tokens"] } : {}),
            },
          });
        }
      })();
      pending.add(work);
      void work.then(() => { pending.delete(work); callback({ code: 0 }); }, () => {
        pending.delete(work); callback({ code: 1, error: new Error("Loopiter trace persistence failed; retry the same spans.") });
      }).catch(() => undefined);
    },
    async forceFlush() { await Promise.all([...pending]); },
    async shutdown() { closed = true; await Promise.all([...pending]); },
  };
}
