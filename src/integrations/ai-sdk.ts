import {
  captureJson,
  captureSnapshot,
  CaptureSession,
  cloneWithOverrides,
  finishStatus,
  resolveContext,
  type CaptureOptions,
  type CaptureStatus,
} from "./capture.js";
import { guidanceMessages } from "./context.js";
export type {
  CaptureOptions,
  ExecutionContext,
  CaptureRequest,
} from "./capture.js";

// Structural model boundary keeps framework packages outside the default SDK import.
interface Model {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  doGenerate(options: never): PromiseLike<unknown>;
  doStream(options: never): PromiseLike<{ stream: ReadableStream<unknown> }>;
}
const baseSymbol = Symbol.for("loopiter/ai-sdk/base-model");

/** Isolated Vercel AI SDK v2/v3/v4 model wrapper (AI SDK 5/6/7). */
export function withLoopiter<T extends Model>(
  model: T,
  options: CaptureOptions,
): T {
  options = { ...options };
  const base = (Reflect.get(model, baseSymbol) as T | undefined) ?? model;
  if (!["v2", "v3", "v4"].includes(base.specificationVersion))
    throw new TypeError("Unsupported AI SDK model specification.");
  async function prepare(raw: unknown) {
    const { abortSignal, headers, ...settings } = raw as Record<
      string,
      unknown
    >;
    const params = {
      ...(captureSnapshot(settings) as {
        prompt: { role: string; content: unknown }[];
      }),
      abortSignal: abortSignal as AbortSignal | undefined,
      headers,
    };
    const input = (value: typeof params) => {
      const {
        abortSignal: _signal,
        headers: _headers,
        ...settings
      } = value as typeof params & { headers?: unknown };
      return captureJson({ ...settings, provider: base.provider });
    };
    const request = {
      integration: "ai-sdk",
      model: base.modelId,
      input: input(params),
    };
    const context = await resolveContext(options, request);
    const actual =
      context.guidance === undefined
        ? params
        : {
            ...params,
            prompt: guidanceMessages(params.prompt, context.guidance),
          };
    request.input = input(actual);
    const session = await CaptureSession.begin(options, context, request);
    return { params: actual, session };
  }
  const wrapped = cloneWithOverrides(base, {
    async doGenerate(raw: unknown) {
      const { params, session } = await prepare(raw);
      try {
        params.abortSignal?.throwIfAborted();
        const result = (await base.doGenerate(params as never)) as {
          finishReason?: unknown;
          content?: unknown;
          usage?: unknown;
        };
        await session.finish(finishStatus(result.finishReason), {
          content: result.content,
          usage: result.usage,
          finishReason: result.finishReason,
        });
        return result;
      } catch (error) {
        await session.finish(
          params.abortSignal?.aborted ? "cancelled" : "failed",
        );
        throw error;
      }
    },
    async doStream(raw: unknown) {
      const { params, session } = await prepare(raw);
      try {
        params.abortSignal?.throwIfAborted();
        const result = await base.doStream(params as never);
        const reader = result.stream.getReader();
        let status: CaptureStatus = "incomplete",
          ended = false;
        const stream = new ReadableStream<unknown>(
          {
            async pull(controller) {
              try {
                const next = await reader.read();
                if (ended) return;
                if (next.done) {
                  await session.finish(
                    params.abortSignal?.aborted ? "cancelled" : status,
                  );
                  ended = true;
                  reader.releaseLock();
                  controller.close();
                  return;
                }
                const part = next.value as {
                  type?: string;
                  finishReason?: unknown;
                };
                session.append(next.value);
                if (part.type === "finish" && status !== "failed")
                  status = finishStatus(part.finishReason);
                if (part.type === "error") status = "failed";
                controller.enqueue(next.value);
              } catch (error) {
                if (ended) return;
                ended = true;
                await reader.cancel(error).catch(() => undefined);
                reader.releaseLock();
                try {
                  await session.finish(
                    params.abortSignal?.aborted ? "cancelled" : "failed",
                  );
                } catch (persistenceError) {
                  controller.error(persistenceError);
                  return;
                }
                controller.error(error);
              }
            },
            async cancel(reason) {
              if (ended) return;
              ended = true;
              try {
                await reader.cancel(reason);
              } finally {
                reader.releaseLock();
                await session.finish("cancelled");
              }
            },
          },
          { highWaterMark: 0 },
        );
        return { ...result, stream };
      } catch (error) {
        await session.finish(
          params.abortSignal?.aborted ? "cancelled" : "failed",
        );
        throw error;
      }
    },
  });
  Object.defineProperty(wrapped, baseSymbol, { value: base });
  return wrapped;
}
