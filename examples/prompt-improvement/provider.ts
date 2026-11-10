import { performance } from "node:perf_hooks";
import type { JsonObject } from "../../src/index.js";
import { integer, json, nonempty, object } from "../../src/utils.js";
export interface GenerateInput {
  instructions: string;
  input: string;
  schema: JsonObject;
  name: string;
  signal: AbortSignal;
  /** Overrides the provider cap for this call. Must be at most that cap. */
  maximumOutputTokens?: number;
  /** When set, the request includes reasoning.effort. Omitted leaves the field off. */
  reasoningEffort?: string;
}
export interface Generation {
  value: JsonObject;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Subset of inputTokens when the response reports a cache. Null if unreported. */
  cachedInputTokens: number | null;
  latencyMs: number;
}
export interface GenerationProvider {
  readonly mode: "live" | "simulated";
  readonly model: string;
  generate(input: GenerateInput): Promise<Generation>;
}
interface ResponseOptions {
  model: string;
  maximumRequests?: number;
  maximumOutputTokens?: number;
  maximumInputBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export interface ResponseUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}
/** HTTP failure. The message is status-only so response bodies and headers stay out of logs. */
export class ProviderRequestError extends Error {
  readonly usage: ResponseUsage | null;
  constructor(readonly status: number, usage: ResponseUsage | null) {
    super(`OpenAI request failed (HTTP ${status}); no automatic retry.`);
    this.name = "ProviderRequestError";
    this.usage = usage;
  }
}
export function responsesRequestBody(input: {
  model: string;
  instructions: string;
  input: string;
  name: string;
  schema: JsonObject;
  maxOutputTokens: number;
  reasoningEffort?: string;
}) {
  return {
    model: input.model,
    store: false as const,
    instructions: input.instructions,
    input: input.input,
    max_output_tokens: input.maxOutputTokens,
    ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    text: {
      format: {
        type: "json_schema" as const,
        name: input.name,
        strict: true as const,
        schema: input.schema,
      },
    },
  };
}
class ResponsesProvider implements GenerationProvider {
  readonly mode = "live" as const;
  readonly model: string;
  private requests = 0;
  constructor(
    private readonly options: ResponseOptions,
    private readonly endpoint: string,
    private readonly authenticate: (signal: AbortSignal) => Promise<Record<string, string>>,
  ) {
    nonempty(options.model, "model/deployment");
    this.model = options.model;
    integer(options.maximumRequests ?? 80, "maximumRequests");
    integer(options.maximumOutputTokens ?? 2048, "maximumOutputTokens");
    integer(options.maximumInputBytes ?? 16384, "maximumInputBytes");
    integer(options.timeoutMs ?? 60000, "timeoutMs");
  }
  async generate(input: GenerateInput): Promise<Generation> {
    input.signal.throwIfAborted();
    json(input.input, this.options.maximumInputBytes ?? 16384);
    if (this.requests >= (this.options.maximumRequests ?? 80))
      throw new Error("Model request budget exhausted.");
    this.requests++;
    const started = performance.now();
    const cap = this.options.maximumOutputTokens ?? 2048;
    const maxOutput = input.maximumOutputTokens ?? cap;
    integer(maxOutput, "maximumOutputTokens");
    if (maxOutput > cap)
      throw new Error("maximumOutputTokens exceeds the provider cap.");
    const timeoutMs = this.options.timeoutMs ?? 60000;
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const authentication = await this.authenticate(signal);
    signal.throwIfAborted();
    const response = await (this.options.fetch ?? fetch)(
      this.endpoint,
      {
        method: "POST",
        headers: {
          ...authentication,
          "Content-Type": "application/json",
        },
        signal,
        redirect: "error",
        body: JSON.stringify(
          responsesRequestBody({
            model: this.model,
            instructions: input.instructions,
            input: input.input,
            name: input.name,
            schema: input.schema,
            maxOutputTokens: maxOutput,
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          }),
        ),
      },
    );
    if (!response.ok) {
      const usage = await usageFromBody(response);
      throw new ProviderRequestError(response.status, usage);
    }
    input.signal.throwIfAborted();
    const body: unknown = await response.json();
    input.signal.throwIfAborted();
    object(body, "OpenAI response");
    if (body.status !== "completed" || !Array.isArray(body.output))
      throw new Error(incompleteMessage(body));
    const texts: string[] = [];
    for (const item of body.output) {
      if (!item || item.type !== "message" || !Array.isArray(item.content))
        continue;
      for (const part of item.content) {
        if (part.type === "refusal")
          throw new Error(
            "Model refused; no candidate/result will be accepted.",
          );
        if (part.type === "output_text" && typeof part.text === "string")
          texts.push(part.text);
      }
    }
    if (!texts.length)
      throw new Error("OpenAI response contained no structured output.");
    const value: unknown = JSON.parse(texts.join(""));
    json(value);
    object(value, "structured output");
    const usage = readUsage(body);
    return {
      value: value as JsonObject,
      model: typeof body.model === "string" ? body.model : this.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      latencyMs: performance.now() - started,
    };
  }
}

export class OpenAIProvider extends ResponsesProvider {
  constructor(options: ResponseOptions & { apiKey: string }) {
    nonempty(options.apiKey, "OPENAI_API_KEY");
    super(options, "https://api.openai.com/v1/responses", async () => ({
      Authorization: `Bearer ${options.apiKey}`,
    }));
  }
}

export class AzureOpenAIProvider extends ResponsesProvider {
  constructor(options: ResponseOptions & {
    endpoint: string;
    apiKey?: string;
    tokenProvider?: (signal: AbortSignal) => Promise<string>;
    /** Query value for api-version. Omitted leaves the provider URL unchanged. */
    apiVersion?: string;
  }) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || endpoint.pathname !== "/")
      throw new Error("Azure endpoint must be an HTTPS resource origin without a path or credentials.");
    if (Boolean(options.apiKey) === Boolean(options.tokenProvider))
      throw new Error("Configure exactly one Azure API key or token provider.");
    if (options.apiKey) nonempty(options.apiKey, "AZURE_OPENAI_API_KEY");
    const url = new URL("openai/v1/responses", endpoint);
    if (options.apiVersion !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.apiVersion))
        throw new Error("Invalid Azure API version.");
      url.searchParams.set("api-version", options.apiVersion);
    }
    super(options, url.href, async (signal) => {
      if (options.tokenProvider) {
        const token = await options.tokenProvider(signal);
        nonempty(token, "Azure authentication token");
        return { Authorization: `Bearer ${token}` };
      }
      return { "api-key": options.apiKey! };
    });
  }
}

function incompleteMessage(body: unknown): string {
  const reason = incompleteReason(body);
  return reason
    ? `OpenAI response was incomplete or malformed (incomplete_details.reason: ${reason}).`
    : "OpenAI response was incomplete or malformed.";
}

/** Only a short token is copied. Response bodies and headers stay out of the message. */
function incompleteReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const details = (body as { incomplete_details?: unknown }).incomplete_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const reason = (details as { reason?: unknown }).reason;
  if (typeof reason !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(reason)) return null;
  return reason;
}

function countUsage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function readUsage(body: unknown): ResponseUsage {
  const usage =
    body && typeof body === "object"
      ? (body as { usage?: unknown }).usage
      : undefined;
  if (!usage || typeof usage !== "object")
    return { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  const record = usage as Record<string, unknown>;
  const details = record.input_tokens_details;
  const cached =
    details && typeof details === "object"
      ? countUsage((details as Record<string, unknown>).cached_tokens)
      : null;
  return {
    inputTokens: countUsage(record.input_tokens),
    outputTokens: countUsage(record.output_tokens),
    cachedInputTokens: cached,
  };
}

async function usageFromBody(response: Response): Promise<ResponseUsage | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return readUsage(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}
