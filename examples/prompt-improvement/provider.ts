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
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface ContentFilterCategory {
  category: string;
  severity: string | null;
}

/** Allowlisted provider fields. Prompt text, headers, and URLs are not copied. */
export interface SafeProviderDetail {
  status: number;
  code: string | null;
  type: string | null;
  innerCode: string | null;
  categories: ContentFilterCategory[];
  incompleteReason: string | null;
}

/** HTTP failure. The message is built only from allowlisted fields. */
export class ProviderRequestError extends Error {
  readonly usage: ResponseUsage | null;
  readonly retryAfterMs: number | null;
  readonly detail: SafeProviderDetail;
  constructor(
    readonly status: number,
    usage: ResponseUsage | null,
    retryAfterMs: number | null = null,
    detail?: SafeProviderDetail,
  ) {
    const safe = detail ?? emptyDetail(status);
    super(formatSafeProviderDetail(safe));
    this.name = "ProviderRequestError";
    this.usage = usage;
    this.retryAfterMs = retryAfterMs;
    this.detail = safe;
  }
}

/** A 200 whose status is not completed. The message carries only the reason token. */
export class IncompleteOutputError extends Error {
  readonly detail: SafeProviderDetail;
  constructor(reason: string | null) {
    const detail = emptyDetail(200);
    detail.incompleteReason = reason;
    super(formatSafeProviderDetail(detail));
    this.name = "IncompleteOutputError";
    this.detail = detail;
  }
}

export function formatSafeProviderDetail(detail: SafeProviderDetail): string {
  if (detail.incompleteReason)
    return `OpenAI response was incomplete or malformed (incomplete_details.reason: ${detail.incompleteReason}).`;
  if (detail.status === 200) return "OpenAI response was incomplete or malformed.";
  const parts = [`HTTP ${detail.status}`];
  if (detail.code) parts.push(`code=${detail.code}`);
  if (detail.type) parts.push(`type=${detail.type}`);
  if (detail.innerCode && detail.innerCode !== detail.code) parts.push(`inner=${detail.innerCode}`);
  if (detail.categories.length) {
    parts.push(
      `categories=${detail.categories
        .map((item) => (item.severity ? `${item.category}:${item.severity}` : item.category))
        .join(",")}`,
    );
  }
  if (parts.length === 1) return `OpenAI request failed (${parts[0]}).`;
  return `OpenAI request failed (${parts.join(", ")}).`;
}

export function parseProviderErrorBody(status: number, body: unknown): SafeProviderDetail {
  const detail = emptyDetail(status);
  const error = recordOf(body && typeof body === "object" ? (body as { error?: unknown }).error : null);
  if (!error) return detail;
  detail.code = safeToken(error.code);
  detail.type = safeToken(error.type);
  const inner = recordOf(error.innererror);
  detail.innerCode = safeToken(inner?.code);
  detail.categories = categoriesFrom(error);
  return detail;
}

function emptyDetail(status: number): SafeProviderDetail {
  return {
    status,
    code: null,
    type: null,
    innerCode: null,
    categories: [],
    incompleteReason: null,
  };
}

function categoriesFrom(error: Record<string, unknown>): ContentFilterCategory[] {
  const found: ContentFilterCategory[] = [];
  const visit = (value: unknown): void => {
    const record = recordOf(value);
    if (!record) return;
    const results = recordOf(record.content_filter_result);
    if (results) {
      for (const [name, item] of Object.entries(results)) {
        if (!SAFE_TOKEN.test(name)) continue;
        const fields = recordOf(item);
        if (!fields) continue;
        const filtered = fields.filtered === true || fields.detected === true;
        if (!filtered) continue;
        found.push({ category: name, severity: safeToken(fields.severity) });
      }
    }
    if (record.innererror) visit(record.innererror);
  };
  visit(error);
  return found;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeToken(value: unknown): string | null {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
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
      const retryAfterMs = retryAfterMsFrom(response);
      const parsed = await readJsonAllowingFailure(response, signal);
      throw new ProviderRequestError(
        response.status,
        parsed ? readUsage(parsed) : null,
        retryAfterMs,
        parseProviderErrorBody(response.status, parsed),
      );
    }
    signal.throwIfAborted();
    const body = await readJsonBody(response, signal);
    signal.throwIfAborted();
    object(body, "OpenAI response");
    if (body.status !== "completed" || !Array.isArray(body.output))
      throw new IncompleteOutputError(incompleteReason(body));
    const texts: string[] = [];
    for (const item of body.output) {
      if (!item || item.type !== "message" || !Array.isArray(item.content))
        continue;
      for (const part of item.content) {
        if (part.type === "refusal") throw new IncompleteOutputError("refusal");
        if (part.type === "output_text" && typeof part.text === "string")
          texts.push(part.text);
      }
    }
    if (!texts.length) throw new IncompleteOutputError("empty_output");
    let value: unknown;
    try {
      value = JSON.parse(texts.join(""));
    } catch {
      throw new IncompleteOutputError("empty_output");
    }
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

/**
 * Wait before a 429 retry. Header values become a duration only.
 * retry-after-ms wins, then Retry-After, then the latest x-ratelimit-reset-* .
 * With none of those, the wait is full-jitter exponential backoff.
 */
export function rateLimitDelayMs(input: {
  headers: Headers;
  retryIndex: number;
  maxWaitMs: number;
  random: () => number;
  now?: number;
}): number {
  const hinted = hintedDelayMs(input.headers, input.now ?? Date.now());
  const chosen = hinted ?? fullJitterMs(input.retryIndex, input.maxWaitMs, input.random);
  if (!Number.isFinite(chosen) || chosen < 0) return input.maxWaitMs;
  return Math.min(input.maxWaitMs, Math.max(0, Math.round(chosen)));
}

function hintedDelayMs(headers: Headers, now: number): number | null {
  const millis = delayNumber(headers.get("retry-after-ms"), 1);
  if (millis !== null) return millis;
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = delayNumber(retryAfter, 1000);
    if (seconds !== null) return seconds;
    const when = Date.parse(retryAfter.trim());
    if (Number.isFinite(when)) return Math.max(0, when - now);
  }
  let reset: number | null = null;
  headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith("x-ratelimit-reset")) return;
    const wait = delayNumber(value, 1000);
    if (wait === null) return;
    reset = reset === null ? wait : Math.max(reset, wait);
  });
  return reset;
}

function delayNumber(value: string | null, scale: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/s$/i, "");
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const scaled = parsed * scale;
  if (!Number.isSafeInteger(Math.round(scaled))) return null;
  return scaled;
}

function fullJitterMs(retryIndex: number, maxWaitMs: number, random: () => number): number {
  const exponent = Math.min(Math.max(retryIndex, 1) - 1, 16);
  const ceiling = Math.min(maxWaitMs, 1000 * 2 ** exponent);
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.max(0, Math.min(1, draw)) : 0;
  return Math.floor(unit * ceiling);
}

/** Milliseconds from retry-after-ms or Retry-After. The header text is not returned. */
function retryAfterMsFrom(response: Response): number | null {
  return hintedDelayMs(response.headers, Date.now());
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

async function readJsonAllowingFailure(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    const text = await readResponseText(response, signal);
    if (!text) return null;
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  return readResponseText(response, signal).then((text) => (text ? JSON.parse(text) : null));
}

function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    response.text().then(
      (text) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        else resolve(text);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
