// Client facade/rewrapping pattern adapted from Supermemory's OpenAI middleware.
// Copyright (c) 2025 Supermemory Inc. MIT; see THIRD_PARTY_NOTICES.md.
import type OpenAI from "openai";
import { APIPromise } from "openai/core/api-promise";
import { Stream } from "openai/core/streaming";
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
import { guidanceMessages, replaceGuidance } from "./context.js";
export type {
  CaptureOptions,
  ExecutionContext,
  CaptureRequest,
} from "./capture.js";

const baseSymbol = Symbol.for("loopiter/openai/base-client");
function logCapture(step: string, error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  console.warn(`loopiter capture ${step} failed: ${name}`);
}
type Payload = Record<string, unknown>;
function statusOf(payload: Payload, api: string): CaptureStatus {
  if (api === "responses")
    return payload.status === "completed"
      ? "completed"
      : payload.status === "failed"
        ? "failed"
        : "incomplete";
  const choices = payload.choices as { finish_reason: unknown }[] | undefined;
  return choices?.length &&
    choices.every(
      (choice) => finishStatus(choice.finish_reason) === "completed",
    )
    ? "completed"
    : "incomplete";
}

/** Wraps chat.completions.create and responses.create; never mutates the supplied client. */
export function withLoopiter<T extends OpenAI>(
  client: T,
  options: CaptureOptions,
): T {
  options = { ...options };
  const base = (Reflect.get(client, baseSymbol) as T | undefined) ?? client;
  function create(resource: object, method: Function, api: string) {
    return (raw: Payload, requestOptions?: OpenAI.RequestOptions) => {
      let session: CaptureSession | undefined;
      const signal = requestOptions?.signal;
      const ready = (async () => {
        try {
          raw = captureSnapshot(raw) as Payload;
        } catch (error) {
          logCapture("snapshot", error);
        }
        let input: ReturnType<typeof captureJson> | null = null;
        try {
          input = captureJson(raw);
        } catch (error) {
          logCapture("snapshot", error);
        }
        const request = {
          integration: `openai.${api}`,
          model: String(raw.model ?? ""),
          input,
        };
        let context: Awaited<ReturnType<typeof resolveContext>> = {
          artifacts: {},
        };
        try {
          context = await resolveContext(options, request);
        } catch (error) {
          logCapture("context", error);
        }
        let params = raw;
        if (context.guidance !== undefined) {
          try {
            params =
              api === "responses"
                ? {
                    ...raw,
                    instructions: replaceGuidance(
                      String(raw.instructions ?? ""),
                      context.guidance,
                    ),
                  }
                : {
                    ...raw,
                    messages: guidanceMessages(
                      raw.messages as { role: string; content: unknown }[],
                      context.guidance,
                    ),
                  };
            request.input = captureJson(params);
          } catch (error) {
            logCapture("context", error);
            params = raw;
          }
        }
        try {
          session = await CaptureSession.begin(options, context, request);
        } catch (error) {
          logCapture("record", error);
        }
        if (signal?.aborted)
          throw signal.reason ?? new Error("Request aborted.");
        const requestPromise = method.call(
          resource,
          params,
          requestOptions,
        ) as APIPromise<unknown>;
        return { requestPromise, params, session };
      })();
      const fail = async (error: unknown): Promise<never> => {
        try {
          await session?.finish(signal?.aborted ? "cancelled" : "failed");
        } catch (finishError) {
          logCapture("complete", finishError);
        }
        throw error;
      };
      const response = ready
        .then(async ({ requestPromise, params, session: capture }) => {
          const http = await requestPromise.asResponse();
          if (!params.stream && capture) {
            try {
              const value = (await http.clone().json()) as Payload;
              await capture.finish(statusOf(value, api), value);
            } catch (error) {
              logCapture("complete", error);
            }
          }
          return {
            response: http,
            options: {},
            controller: new AbortController(),
          };
        })
        .catch(fail);
      // APIPromise is lazy-parsed; a caller can intentionally use only asResponse().
      void response.catch(() => undefined);
      return new APIPromise<unknown>(base, response as never, async () => {
        try {
          const { requestPromise, params, session: capture } = await ready;
          const value = await requestPromise;
          if (!params.stream) return value;
          const source = value as Stream<Payload>;
          let consumed = false;
          return new Stream<Payload>(
            async function* () {
              if (consumed)
                throw new Error(
                  "Captured streams can be consumed once; use tee().",
                );
              consumed = true;
              let ended = false,
                status: CaptureStatus = "incomplete";
              const finishedChoices = new Set<number>();
              let incompleteChoice = false;
              try {
                for await (const part of source) {
                  try {
                    capture?.append(part);
                  } catch (error) {
                    logCapture("append", error);
                  }
                  if (api === "responses") {
                    if (
                      [
                        "response.completed",
                        "response.failed",
                        "response.incomplete",
                      ].includes(String(part.type))
                    )
                      status = statusOf(part.response as Payload, api);
                  } else {
                    for (const choice of (part.choices ?? []) as {
                      index: number;
                      finish_reason: unknown;
                    }[])
                      if (
                        choice.finish_reason !== null &&
                        choice.finish_reason !== undefined
                      ) {
                        if (finishStatus(choice.finish_reason) !== "completed")
                          incompleteChoice = true;
                        finishedChoices.add(choice.index);
                      }
                    if (
                      !incompleteChoice &&
                      finishedChoices.size >= Number(params.n ?? 1)
                    )
                      status = "completed";
                  }
                  yield part;
                }
                ended = true;
              } catch (error) {
                status = signal?.aborted ? "cancelled" : "failed";
                throw error;
              } finally {
                try {
                  await capture?.finish(
                    status === "failed"
                      ? "failed"
                      : !ended ||
                          source.controller.signal.aborted ||
                          signal?.aborted
                        ? "cancelled"
                        : status,
                  );
                } catch (error) {
                  logCapture("complete", error);
                }
              }
            },
            source.controller,
            base,
          );
        } catch (error) {
          return fail(error);
        }
      });
    };
  }
  const unsupportedStream = () => {
    throw new TypeError(
      "Use create({ stream: true }) for captured streaming; stream() helpers are not supported.",
    );
  };
  const chat = cloneWithOverrides(base.chat, {
    completions: cloneWithOverrides(base.chat.completions, {
      create: create(
        base.chat.completions,
        base.chat.completions.create,
        "chat.completions",
      ),
      stream: unsupportedStream,
    }),
  });
  const responses = cloneWithOverrides(base.responses, {
    create: create(base.responses, base.responses.create, "responses"),
    stream: unsupportedStream,
  });
  const wrapped = cloneWithOverrides(base, { chat, responses });
  Object.defineProperty(wrapped, baseSymbol, { value: base });
  return wrapped;
}
