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
function logCapture(step: string, error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  console.warn(`loopiter capture ${step} failed: ${name}`);
}

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
    const source = (raw ?? {}) as Record<string, unknown>;
    const abortSignal = source.abortSignal as AbortSignal | undefined;
    const headers = source.headers;
    let params = { ...source, abortSignal, headers } as {
      prompt: { role: string; content: unknown }[];
      abortSignal?: AbortSignal;
      headers?: unknown;
    };
    let session: CaptureSession | undefined;
    try {
      const { abortSignal: _signal, headers: _headers, ...settings } = source;
      const snapped: typeof params = {
        ...(captureSnapshot(settings) as {
          prompt: { role: string; content: unknown }[];
        }),
      };
      if (abortSignal !== undefined) snapped.abortSignal = abortSignal;
      if (headers !== undefined) snapped.headers = headers;
      params = snapped;
    } catch (error) {
      logCapture("prepare", error);
      return { params, session };
    }
    const readInput = (value: typeof params) => {
      const {
        abortSignal: _signal,
        headers: _headers,
        ...settings
      } = value;
      return captureJson({ ...settings, provider: base.provider });
    };
    let recorded: ReturnType<typeof captureJson>;
    try {
      recorded = readInput(params);
    } catch (error) {
      logCapture("prepare", error);
      return { params, session };
    }
    const request = {
      integration: "ai-sdk",
      model: base.modelId,
      input: recorded,
    };
    let context: Awaited<ReturnType<typeof resolveContext>> = {
      artifacts: {},
    };
    try {
      context = await resolveContext(options, request);
    } catch (error) {
      logCapture("context", error);
    }
    if (context.guidance !== undefined) {
      try {
        params = {
          ...params,
          prompt: guidanceMessages(params.prompt, context.guidance),
        };
        request.input = readInput(params);
      } catch (error) {
        logCapture("context", error);
      }
    }
    try {
      session = await CaptureSession.begin(options, context, request);
    } catch (error) {
      logCapture("record", error);
    }
    return { params, session };
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
        try {
          await session?.finish(finishStatus(result.finishReason), {
            content: result.content,
            usage: result.usage,
            finishReason: result.finishReason,
          });
        } catch (error) {
          logCapture("complete", error);
        }
        return result;
      } catch (error) {
        try {
          await session?.finish(
            params.abortSignal?.aborted ? "cancelled" : "failed",
          );
        } catch (finishError) {
          logCapture("complete", finishError);
        }
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
                  try {
                    await session?.finish(
                      params.abortSignal?.aborted ? "cancelled" : status,
                    );
                  } catch (error) {
                    logCapture("complete", error);
                  }
                  ended = true;
                  reader.releaseLock();
                  controller.close();
                  return;
                }
                const part = next.value as {
                  type?: string;
                  finishReason?: unknown;
                };
                try {
                  session?.append(next.value);
                } catch (error) {
                  logCapture("append", error);
                }
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
                  await session?.finish(
                    params.abortSignal?.aborted ? "cancelled" : "failed",
                  );
                } catch (finishError) {
                  logCapture("complete", finishError);
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
                try {
                  await session?.finish("cancelled");
                } catch (error) {
                  logCapture("complete", error);
                }
              }
            },
          },
          { highWaterMark: 0 },
        );
        return { ...result, stream };
      } catch (error) {
        try {
          await session?.finish(
            params.abortSignal?.aborted ? "cancelled" : "failed",
          );
        } catch (finishError) {
          logCapture("complete", finishError);
        }
        throw error;
      }
    },
  });
  Object.defineProperty(wrapped, baseSymbol, { value: base });
  return wrapped;
}
