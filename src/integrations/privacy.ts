import type { JsonValue } from "../contracts.js";

export interface CapturePolicy {
  /** full is explicit consent to retain payloads; telemetry is not a replay archive. */
  mode: "full" | "redacted" | "metadata-only";
  maximumBytes?: number;
  /** Runs before built-in redaction and size checks. Never mutate application values. */
  redact?: (value: JsonValue) => JsonValue;
}

// Shared with python/src/loopiter/integrations/privacy.py. Listed explicitly:
// U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR, U+0020 SPACE,
// U+0085 NEXT LINE, U+00A0 NO-BREAK SPACE, U+1680 OGHAM SPACE MARK,
// U+180E MONGOLIAN VOWEL SEPARATOR,
// U+2000 EN QUAD, U+2001 EM QUAD, U+2002 EN SPACE, U+2003 EM SPACE,
// U+2004 THREE-PER-EM SPACE, U+2005 FOUR-PER-EM SPACE, U+2006 SIX-PER-EM SPACE,
// U+2007 FIGURE SPACE, U+2008 PUNCTUATION SPACE, U+2009 THIN SPACE, U+200A HAIR SPACE,
// U+200B ZERO WIDTH SPACE,
// U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, U+202F NARROW NO-BREAK SPACE,
// U+205F MEDIUM MATHEMATICAL SPACE, U+3000 IDEOGRAPHIC SPACE, U+FEFF BOM.
const WS_CHARS =
  "\t\n\v\f\r \u0085\u00a0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u2028\u2029\u202f\u205f\u3000\ufeff";
const WS_SET = new Set(WS_CHARS);
// U+180E and U+200B may separate a label from a value. They do not end the value.
const FORMAT_WS = new Set(["\u180e", "\u200b"]);
const VALUE_BREAK = [...WS_CHARS].filter((ch) => !FORMAT_WS.has(ch)).join("");
const WS = `[${WS_CHARS}]`;
const credentialKey = new RegExp(
  "^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credentials|x[-_]?api[-_]?key|private[-_]?key|token|session)$",
  "i",
);
const bearer = new RegExp(`(?<![A-Za-z0-9_])Bearer${WS}+[A-Za-z0-9+/_.=~-]+`, "gi");
const basic = new RegExp(
  `(?<![A-Za-z0-9_])[Bb][Aa][Ss][Ii][Cc]${WS}+(?![a-z]+(?![A-Za-z0-9_]))[A-Za-z0-9+/_.=~-]+`,
  "g",
);
const tokens = /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9_])/g;
const jwt = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const awsSecret = new RegExp(
  `(?<![A-Za-z0-9])(["']?(?:aws[-_]?)?secret[-_]?access[-_]?key["']?${WS}*[=:]${WS}*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])`,
  "gi",
);
const assigned = new RegExp(
  `((?:password|api[_-]?key|access[_-]?token|secret)${WS}*[=:]${WS}*)[^${VALUE_BREAK}&,;]+`,
  "gi",
);
const queryToken = new RegExp(
  `((?:^|[${WS_CHARS}?&#])(?:access_token|token)=)[^${VALUE_BREAK}&#]+`,
  "gi",
);
const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g;
const localChar = /[A-Za-z0-9._%+-]/;
const domainChar = /[A-Za-z0-9.-]/;
const schemeChar = /[A-Za-z0-9+.-]/;

function isWs(char: string): boolean {
  return WS_SET.has(char);
}

function redactUrls(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("://", i);
    if (at < 0) return out + value.slice(i);
    let s = at - 1;
    if (s < i || !/[A-Za-z]/.test(value[s]!)) {
      out += value.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    while (s > i && schemeChar.test(value[s - 1]!)) s -= 1;
    if (!/[A-Za-z]/.test(value[s]!)) {
      out += value.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    let j = at + 3;
    const userStart = j;
    while (j < value.length && !isWs(value[j]!) && value[j] !== "/" && value[j] !== "@" && value[j] !== ":") j += 1;
    if (j === userStart || value[j] !== ":") {
      out += value.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    j += 1;
    const passStart = j;
    while (j < value.length && !isWs(value[j]!) && value[j] !== "/" && value[j] !== "@") j += 1;
    if (j === passStart || value[j] !== "@") {
      out += value.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    out += value.slice(i, s) + value.slice(s, at) + "://[REDACTED]@";
    i = j + 1;
  }
  return out;
}

function redactEmails(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("@", i);
    if (at < 0) return out + value.slice(i);
    let left = at;
    while (left > i && localChar.test(value[left - 1]!)) left -= 1;
    const prev = left > 0 ? value[left - 1]! : "";
    const boundary = left === 0 || isWs(prev) || prev === "<" || prev === "(" || prev === ":";
    let j = at + 1;
    while (j < value.length && domainChar.test(value[j]!)) j += 1;
    const domain = value.slice(at + 1, j);
    const dot = domain.lastIndexOf(".");
    const tld = dot >= 0 ? domain.slice(dot + 1) : "";
    const next = j < value.length ? value[j]! : "";
    if (
      left === at ||
      !boundary ||
      dot <= 0 ||
      !/^[A-Za-z]{2,}$/.test(tld) ||
      (next !== "" && /[A-Za-z0-9]/.test(next))
    ) {
      out += value.slice(i, at + 1);
      i = at + 1;
      continue;
    }
    out += value.slice(i, left) + "[REDACTED]";
    i = j;
  }
  return out;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const cardLayouts: readonly (readonly number[])[] = [
  [4, 4, 4, 4],
  [4, 4, 4, 4, 3],
  [4, 6, 5],
  [4, 6, 4],
  [4, 4, 5],
  [4, 4, 4, 3],
  [4, 4, 6],
];

function layoutPrefix(groups: readonly number[]): boolean {
  return cardLayouts.some((layout) => layout.length >= groups.length && layout.slice(0, groups.length).every((size, index) => size === groups[index]));
}

function longerLayout(groups: readonly number[]): boolean {
  return cardLayouts.some((layout) => layout.length > groups.length && layout.slice(0, groups.length).every((size, index) => size === groups[index]));
}

function exactLayout(groups: readonly number[]): boolean {
  return cardLayouts.some((layout) => layout.length === groups.length && layout.every((size, index) => size === groups[index]));
}

function redactCards(value: string): string {
  let out = "";
  let i = 0;
  const digit = (index: number) => {
    const code = value.charCodeAt(index);
    return code >= 48 && code <= 57;
  };
  const nextGroup = (from: number) => {
    let j = from;
    while (j < value.length && digit(j)) j += 1;
    if (j < value.length && (value[j] === " " || value[j] === "-") && j + 1 < value.length && digit(j + 1))
      return j + 1;
    return j;
  };
  while (i < value.length) {
    if (!digit(i) || (i > 0 && digit(i - 1))) {
      out += value[i];
      i += 1;
      continue;
    }
    const start = i;
    let j = i;
    while (j < value.length && digit(j)) j += 1;
    const first = j - start;
    const grouped = j < value.length && (value[j] === " " || value[j] === "-") && j + 1 < value.length && digit(j + 1);
    if (!grouped) {
      if (first >= 13 && first <= 19 && luhn(value.slice(start, j))) out += "[REDACTED]";
      else out += value.slice(start, j);
      i = j;
      continue;
    }
    if (!layoutPrefix([first])) {
      const nxt = nextGroup(start);
      out += value.slice(start, nxt);
      i = nxt;
      continue;
    }
    const groups = [first];
    const ends = [j];
    let total = first;
    const sep = value[j]!;
    while (j < value.length && value[j] === sep && j + 1 < value.length && digit(j + 1) && longerLayout(groups)) {
      let k = j + 1;
      while (k < value.length && digit(k)) k += 1;
      const nxt = k - (j + 1);
      if (total + nxt > 19 || !layoutPrefix(groups.concat(nxt))) break;
      total += nxt;
      groups.push(nxt);
      ends.push(k);
      j = k;
    }
    let matched = -1;
    for (let count = groups.length; count > 0; count -= 1) {
      const prefix = groups.slice(0, count);
      if (!exactLayout(prefix)) continue;
      const end = ends[count - 1]!;
      if (luhn(value.slice(start, end).replace(/[ -]/g, ""))) {
        matched = end;
        break;
      }
    }
    if (matched >= 0) {
      out += "[REDACTED]";
      i = matched;
      continue;
    }
    const resume = nextGroup(start);
    out += value.slice(start, resume);
    i = resume;
  }
  return out;
}

function redactText(value: string): string {
  return redactCards(
    redactEmails(
      redactUrls(
        value
          .replace(bearer, "Bearer [REDACTED]")
          .replace(basic, "Basic [REDACTED]")
          .replace(tokens, "[REDACTED]")
          .replace(jwt, "[REDACTED]")
          .replace(awsSecret, "$1[REDACTED]")
          .replace(assigned, "$1[REDACTED]")
          .replace(queryToken, "$1[REDACTED]")
          .replace(privateKey, "[REDACTED]"),
      ),
    ),
  );
}

function walk(value: JsonValue, patterns: boolean): JsonValue {
  if (typeof value === "string") return patterns ? redactText(value) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, patterns));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        credentialKey.test(key) ? "[REDACTED]" : walk(item, patterns),
      ]),
    );
  return value;
}

/** Pattern redaction is deliberately conservative, not a guarantee of anonymization. */
export function redactCapture(value: JsonValue): JsonValue {
  return walk(value, true);
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
  const prepared = policy.mode === "redacted" ? walk(custom, false) : custom;
  const preparedBytes = Buffer.byteLength(JSON.stringify(prepared), "utf8");
  if (policy.mode === "redacted" && preparedBytes > maximum)
    return {
      value: { omitted: true, truncated: true, bytes: preparedBytes } as JsonValue,
      truncated: true,
      complete: false,
    };
  const clean = policy.mode === "redacted" ? walk(prepared, true) : prepared;
  const bytes = Buffer.byteLength(JSON.stringify(clean), "utf8");
  // Omit whole oversized payloads, never store a partially redacted secret or invalid JSON.
  if (bytes > maximum)
    return { value: { omitted: true, truncated: true, bytes } as JsonValue, truncated: true, complete: false };
  return { value: clean, truncated: false, complete: policy.mode === "full" && !policy.redact };
}
