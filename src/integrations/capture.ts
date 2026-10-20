import { randomUUID } from "node:crypto";
import type {
  AiExecution,
  ArtifactVersions,
  JsonObject,
  JsonValue,
} from "../contracts.js";
import type { FeedbackLoop } from "../feedback-loop.js";

export interface ExecutionContext {
  /** A new ID for each provider call, including steps in a tool loop. */
  id?: string;
  episodeId?: string;
  entityId?: string;
  parentExecutionId?: string;
  artifacts: ArtifactVersions;
  metadata?: JsonObject;
  /** Application-selected released guidance; requires artifacts.prompt. */
  guidance?: string;
}

export interface CaptureRequest {
  integration: string;
  model: string;
  input: JsonValue;
}

export interface CaptureOptions {
  loop: FeedbackLoop;
  /** Resolve per request, rather than mutating a shared client with tenant state. */
  context(
    request: CaptureRequest,
  ): ExecutionContext | Promise<ExecutionContext>;
  /** Bound stream buffering. Overflow fails capture and cancels consumption. */
  maximumOutputBytes?: number;
  /** Awaited after persistence, including the initial pending record. */
  onExecution?(execution: AiExecution): void | Promise<void>;
}

export type CaptureStatus = "completed" | "incomplete" | "cancelled" | "failed";

/** Provider values are normalized before the normal SDK sanitizer and byte limits. */
function providerValue(value: unknown, normalize: boolean): unknown {
  const ancestors = new Set<object>();
  function visit(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (item instanceof URL) return normalize ? item.href : new URL(item.href);
    if (item instanceof Uint8Array)
      return normalize
        ? { encoding: "base64", data: Buffer.from(item).toString("base64") }
        : new Uint8Array(item);
    if (typeof item !== "object" || !item || ancestors.has(item))
      throw new TypeError(
        "Captured provider payloads must be finite, acyclic JSON values.",
      );
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(visit);
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new TypeError(
          "Unsupported provider payload object; supply plain JSON.",
        );
      const result: Record<string, unknown> = Object.create(
        normalize ? null : Object.getPrototypeOf(item),
      );
      for (const [key, entry] of Object.entries(item))
        if (entry !== undefined)
          Object.defineProperty(result, key, {
            value: visit(entry),
            enumerable: true,
            configurable: true,
            writable: true,
          });
      return result;
    } finally {
      ancestors.delete(item);
    }
  }
  return visit(value);
}

export function captureJson(value: unknown): JsonValue {
  return providerValue(value, true) as JsonValue;
}

/** Detach supported request payloads before awaiting application callbacks. */
export function captureSnapshot(value: unknown): unknown {
  return providerValue(value, false);
}

export function finishStatus(reason: unknown): CaptureStatus {
  const normalized =
    typeof reason === "object" && reason !== null
      ? (reason as { unified?: unknown }).unified
      : reason;
  return ["stop", "tool_calls", "tool-calls", "function_call"].includes(
    String(normalized),
  )
    ? "completed"
    : normalized === "error"
      ? "failed"
      : "incomplete";
}

export async function resolveContext(
  options: CaptureOptions,
  request: CaptureRequest,
) {
  // Detach mutable application configuration before any external operation.
  const context = captureJson(
    await options.context(structuredClone(request)),
  ) as unknown as ExecutionContext;
  if (!context.artifacts || typeof context.artifacts !== "object")
    throw new TypeError("Capture context requires artifact versions.");
  if (
    context.guidance !== undefined &&
    (typeof context.guidance !== "string" || !context.artifacts.prompt)
  )
    throw new TypeError(
      "Released guidance requires a string and artifacts.prompt.",
    );
  return context;
}

export class CaptureSession {
  private finalization: Promise<void> | undefined;
  private bytes = 0;
  private readonly events: JsonValue[] = [];
  private constructor(
    private readonly options: CaptureOptions,
    readonly execution: AiExecution,
    private readonly maximum: number,
  ) {}

  static async begin(
    options: CaptureOptions,
    context: ExecutionContext,
    request: CaptureRequest,
  ) {
    const maximum = options.maximumOutputBytes ?? 65536;
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new TypeError("maximumOutputBytes must be a positive integer.");
    const attemptId = randomUUID();
    const execution = await options.loop.recordExecution({
      ...(context.id === undefined ? {} : { id: context.id }),
      ...(context.episodeId === undefined
        ? {}
        : { episodeId: context.episodeId }),
      ...(context.entityId === undefined ? {} : { entityId: context.entityId }),
      ...(context.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: context.parentExecutionId }),
      kind: "inference",
      input: request.input,
      artifacts: { ...context.artifacts, model: request.model },
      metadata: {
        ...context.metadata,
        loopiterCapture: {
          attemptId,
          integration: request.integration,
          status: "pending",
        },
      },
    });
    const identity = execution.metadata.loopiterCapture as
      | JsonObject
      | undefined;
    if (identity?.attemptId !== attemptId || identity.status !== "pending")
      throw new Error(
        "The sanitizer must preserve loopiterCapture identity and status.",
      );
    const session = new CaptureSession(options, execution, maximum);
    try {
      await options.onExecution?.(structuredClone(execution));
    } catch (error) {
      await session.finish("failed");
      throw error;
    }
    return session;
  }

  append(event: unknown): void {
    const value = captureJson(event);
    this.bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.bytes > this.maximum)
      throw new RangeError("Captured stream exceeded maximumOutputBytes.");
    this.events.push(value);
  }

  async finish(status: CaptureStatus, output?: unknown): Promise<void> {
    if (this.finalization) return this.finalization;
    let value =
      output === undefined ? { events: this.events } : captureJson(output);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > this.maximum) {
      if (status === "completed" || status === "incomplete")
        throw new RangeError("Captured response exceeded maximumOutputBytes.");
      value = null;
    }
    this.finalization = this.finalize(status, value);
    return this.finalization;
  }

  private async finalize(status: CaptureStatus, value: JsonValue) {
    const saved = await this.options.loop.completeExecution(
      this.execution.id,
      {
        output: value,
        metadata: {
          loopiterCapture: {
            ...(this.execution.metadata.loopiterCapture as JsonObject),
            status,
          },
        },
      },
      this.execution.revision,
    );
    const identity = saved.metadata.loopiterCapture as JsonObject | undefined;
    if (
      identity?.status !== status ||
      identity.attemptId !==
        (this.execution.metadata.loopiterCapture as JsonObject).attemptId
    )
      throw new Error(
        "The sanitizer must preserve loopiterCapture identity and status.",
      );
    await this.options.onExecution?.(structuredClone(saved));
  }
}

/** Adapted from Supermemory OpenAI middleware's descriptor-preserving clone. */
export function cloneWithOverrides<T extends object>(
  source: T,
  overrides: object,
): T {
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of Reflect.ownKeys(overrides))
    Object.defineProperty(descriptors, key, {
      value: {
        configurable: true,
        enumerable: true,
        writable: true,
        value: Reflect.get(overrides, key),
      },
      configurable: true,
      enumerable: true,
      writable: true,
    });
  return Object.create(Object.getPrototypeOf(source), descriptors) as T;
}
