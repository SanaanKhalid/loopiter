import type { JsonValue } from "../contracts.js";

export interface CapturePolicy {
  /** full is explicit consent to retain payloads; telemetry is not a replay archive. */
  mode: "full" | "redacted" | "metadata-only";
  maximumBytes?: number;
  /** Runs before built-in redaction and size checks. Never mutate application values. */
  redact?: (value: JsonValue) => JsonValue;
}

const credentialKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credentials|x[-_]?api[-_]?key|private[-_]?key|token)$/i;
function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9+/_.=~-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[Bb][Aa][Ss][Ii][Cc]\s+(?![a-z]+\b)[A-Za-z0-9+/_.=~-]+/g, "Basic [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(?<=^|\s)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED]")
    .replace(/((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s&,;]+/gi, "$1[REDACTED]")
    .replace(/((?:^|[\s?&#])(?:access_token|token)=)[^\s&#]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]");
}

/** Pattern redaction is deliberately conservative, not a guarantee of anonymization. */
export function redactCapture(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactCapture);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, credentialKey.test(key) ? "[REDACTED]" : redactCapture(item)]));
  return value;
}

export function capturePayload(value: JsonValue, policy: CapturePolicy) {
  const maximum = policy.maximumBytes ?? 65536;
  if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > 1048576)
    throw new TypeError("Capture maximumBytes must be between 128 and 1048576.");
  if (!["full", "redacted", "metadata-only"].includes(policy.mode))
    throw new TypeError("Invalid capture mode.");
  if (policy.mode === "metadata-only")
    return { value: { omitted: true } as JsonValue, truncated: false, complete: false };
  const custom = policy.redact ? policy.redact(structuredClone(value)) : value;
  const clean = policy.mode === "redacted" ? redactCapture(custom) : custom;
  const serialized = JSON.stringify(clean);
  const bytes = Buffer.byteLength(serialized, "utf8");
  // Omit whole oversized payloads, never store a partially redacted secret or invalid JSON.
  if (bytes > maximum)
    return { value: { omitted: true, truncated: true, bytes } as JsonValue, truncated: true, complete: false };
  return { value: clean, truncated: false, complete: policy.mode === "full" && !policy.redact };
}
