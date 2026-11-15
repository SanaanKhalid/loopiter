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
  `(?<![A-Za-z0-9_])[Bb][Aa][Ss][Ii][Cc]${WS}+(?![a-z]+(?![A-Za-z0-9_/+.=~-]))[A-Za-z0-9+/_.=~-]+`,
  "g",
);
const tokens = /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9_])/g;
const jwt = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const jwtBody = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/y;
const JWT_EDGE = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
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
const armor = /-----BEGIN [^-]*PRIVATE KEY-----|-----END [^-]*PRIVATE KEY-----/g;
const tokenBody = /(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})/y;
const localChar = /[A-Za-z0-9._%+-]/;
const domainChar = /[A-Za-z0-9.-]/;
const schemeChar = /[A-Za-z0-9+.-]/;

function isWs(char: string): boolean {
  return WS_SET.has(char);
}

type Span = [number, number, string, number];
const MARKER = "[REDACTED]";
const CARD_LAYOUTS: readonly (readonly number[])[] = [
  [4, 4, 4, 4, 3],
  [4, 4, 4, 4],
  [4, 6, 5],
  [4, 6, 4],
  [4, 4, 5],
  [4, 4, 4, 3],
  [4, 4, 6],
  [8, 8],
  [4, 4, 8],
  [4, 12],
];
const EXACT_LAYOUTS = new Set(CARD_LAYOUTS.map((layout) => layout.join(",")));
const LAYOUT_PREFIXES = new Set(
  CARD_LAYOUTS.flatMap((layout) => layout.map((_, index) => layout.slice(0, index + 1).join(","))),
);
const TOKEN_CHARS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_.=~-");

function isAsciiDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function pushUrls(value: string, spans: Span[]): void {
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("://", i);
    if (at < 0) return;
    let s = at - 1;
    if (s < i || !/[A-Za-z]/.test(value[s]!)) {
      i = at + 3;
      continue;
    }
    while (s > i && schemeChar.test(value[s - 1]!)) s -= 1;
    if (!/[A-Za-z]/.test(value[s]!)) {
      i = at + 3;
      continue;
    }
    let j = at + 3;
    const userStart = j;
    while (j < value.length && !isWs(value[j]!) && value[j] !== "/" && value[j] !== "@" && value[j] !== ":") j += 1;
    if (j === userStart || value[j] !== ":") {
      i = at + 3;
      continue;
    }
    j += 1;
    const passStart = j;
    while (j < value.length && !isWs(value[j]!) && value[j] !== "/" && value[j] !== "@") j += 1;
    if (j === passStart || value[j] !== "@") {
      i = at + 3;
      continue;
    }
    spans.push([userStart, j, MARKER, userStart]);
    i = j + 1;
  }
}

function emailDomainEnd(domain: string): number {
  let best = 0;
  let index = 0;
  while (index < domain.length) {
    if (domain[index] !== ".") {
      index += 1;
      continue;
    }
    let tld = index + 1;
    while (tld < domain.length && /[A-Za-z]/.test(domain[tld]!)) tld += 1;
    if (index > 0 && tld - index > 2) best = tld;
    index = tld > index ? tld : index + 1;
  }
  return best;
}

function pushEmails(value: string, spans: Span[], blocked: Array<[number, number]>, edges: Set<number>): void {
  let i = 0;
  let pointer = 0;
  while (i < value.length) {
    const at = value.indexOf("@", i);
    if (at < 0) return;
    let left = at;
    while (left > i && localChar.test(value[left - 1]!)) left -= 1;
    const prev = left > 0 ? value[left - 1]! : "";
    const boundary = left === 0 || isWs(prev) || prev === "<" || prev === "(" || prev === ":" || edges.has(left);
    let j = at + 1;
    while (j < value.length && domainChar.test(value[j]!)) j += 1;
    const prefix = emailDomainEnd(value.slice(at + 1, j));
    const end = at + 1 + prefix;
    const next = end < value.length ? value[end]! : "";
    const full = prefix === j - (at + 1);
    const rightBlocked = full && next !== "" && /[A-Za-z0-9]/.test(next) && !edges.has(end);
    if (left === at || !boundary || prefix === 0 || rightBlocked) {
      i = at + 1;
      continue;
    }
    while (pointer < blocked.length && blocked[pointer]![1] <= left) pointer += 1;
    const block = blocked[pointer];
    if (block && block[0] < end && left < block[1]) {
      i = end;
      continue;
    }
    spans.push([left, end, MARKER, left]);
    i = end;
  }
}

function spanEdges(spans: Span[]): Set<number> {
  const edges = new Set<number>();
  for (const span of spans) {
    edges.add(span[0]);
    edges.add(span[1]);
  }
  return edges;
}

function jwtBoundary(value: string, index: number, atEnd: boolean, edges: Set<number>): boolean {
  if (atEnd) {
    if (index === value.length || edges.has(index)) return true;
    return !JWT_EDGE.has(value[index]!);
  }
  if (index === 0 || edges.has(index)) return true;
  return !JWT_EDGE.has(value[index - 1]!);
}

function pushJwts(value: string, spans: Span[], edges: Set<number>): void {
  collect(jwt, value, spans, () => MARKER, (match) => match.index ?? 0);
  const covered = new Set(spans.map((span) => span[0]));
  for (const edge of edges) {
    if (covered.has(edge) || !value.startsWith("eyJ", edge)) continue;
    jwtBody.lastIndex = edge;
    const match = jwtBody.exec(value);
    if (!match || match.index !== edge) continue;
    const end = edge + match[0].length;
    if (!jwtBoundary(value, end, true, edges)) continue;
    spans.push([edge, end, MARKER, edge]);
    covered.add(edge);
  }
  jwtBody.lastIndex = 0;
}

function luhnOk(even: number[], odd: number[], start: number, end: number): boolean {
  const total = (end % 2 === 0 ? even[end]! - even[start]! : odd[end]! - odd[start]!) ;
  return total % 10 === 0;
}

function pushCards(value: string, spans: Span[]): void {
  const length = value.length;
  const even = new Array<number>(length + 1).fill(0);
  const odd = new Array<number>(length + 1).fill(0);
  let i = 0;
  const digitAt = (index: number) => {
    const code = value.charCodeAt(index);
    return code >= 48 && code <= 57;
  };
  while (i < length) {
    if (!digitAt(i)) {
      i += 1;
      continue;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    const seps: string[] = [];
    const glens: number[] = [];
    const gdigit = [0];
    let seen = 0;
    while (i < length && digitAt(i)) {
      starts.push(i);
      let glen = 0;
      while (i < length && digitAt(i)) {
        const n = value.charCodeAt(i) - 48;
        let doubled = n * 2;
        if (doubled > 9) doubled -= 9;
        const prev = seen;
        seen += 1;
        if (prev % 2 === 0) {
          even[seen] = even[prev]! + doubled;
          odd[seen] = odd[prev]! + n;
        } else {
          even[seen] = even[prev]! + n;
          odd[seen] = odd[prev]! + doubled;
        }
        glen += 1;
        i += 1;
      }
      ends.push(i);
      glens.push(glen);
      gdigit.push(seen);
      if (i + 1 < length && (value[i] === " " || value[i] === "-") && digitAt(i + 1)) {
        seps.push(value[i]!);
        i += 1;
        continue;
      }
      seps.push("");
      break;
    }
    let group = 0;
    const count = glens.length;
    while (group < count) {
      const startAt = starts[group]!;
      if (startAt !== 0 && isAsciiDigit(value[startAt - 1]!)) {
        group += 1;
        continue;
      }
      const glen = glens[group]!;
      const groupEnd = ends[group]!;
      if (
        glen >= 13 &&
        glen <= 19 &&
        luhnOk(even, odd, gdigit[group]!, gdigit[group + 1]!) &&
        (groupEnd === length || !isAsciiDigit(value[groupEnd]!))
      ) {
        spans.push([startAt, groupEnd, MARKER, startAt]);
        group += 1;
        continue;
      }
      const sep = seps[group]!;
      if (sep === "" || (glen !== 4 && glen !== 8)) {
        group += 1;
        continue;
      }
      if (
        glen === 4 &&
        group + 3 < count &&
        glens[group + 1] === 4 &&
        glens[group + 2] === 4 &&
        glens[group + 3] === 4 &&
        seps[group + 1] === sep &&
        seps[group + 2] === sep
      ) {
        let matched = 0;
        const base = gdigit[group]!;
        const fifth = group + 4;
        if (
          fifth < count &&
          glens[fifth] === 3 &&
          seps[group + 3] === sep &&
          luhnOk(even, odd, base, gdigit[group + 5]!) &&
          (ends[fifth] === length || !isAsciiDigit(value[ends[fifth]!]!))
        ) {
          matched = 5;
        } else if (
          luhnOk(even, odd, base, gdigit[group + 4]!) &&
          (ends[group + 3] === length || !isAsciiDigit(value[ends[group + 3]!]!))
        ) {
          matched = 4;
        }
        if (matched) {
          spans.push([startAt, ends[group + matched - 1]!, MARKER, startAt]);
          group += matched;
        } else group += 1;
        continue;
      }
      const lengths = [glen];
      let look = group + 1;
      while (look < count && seps[look - 1] === sep) {
        const candidate = lengths.concat(glens[look]!).join(",");
        if (!LAYOUT_PREFIXES.has(candidate)) break;
        lengths.push(glens[look]!);
        look += 1;
      }
      let matched = 0;
      const base = gdigit[group]!;
      for (let size = lengths.length; size > 0; size -= 1) {
        if (!EXACT_LAYOUTS.has(lengths.slice(0, size).join(","))) continue;
        const endGroup = group + size;
        const endAt = ends[endGroup - 1]!;
        if (luhnOk(even, odd, base, gdigit[endGroup]!) && (endAt === length || !isAsciiDigit(value[endAt]!))) {
          matched = endGroup;
          break;
        }
      }
      if (matched === 0) {
        group += 1;
        continue;
      }
      spans.push([startAt, ends[matched - 1]!, MARKER, startAt]);
      group = matched;
    }
  }
}

function applySpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - b[0] - (a[1] - a[0]));
  const kept: Span[] = [];
  let cover = -1;
  for (const span of spans) {
    if (span[0] >= span[1] || span[1] <= cover) continue;
    cover = span[1];
    kept.push(span);
  }
  if (kept.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < kept.length) {
    const cluster: Span[] = [kept[index]!];
    let clusterEnd = kept[index]![1];
    index += 1;
    while (index < kept.length && kept[index]![0] <= clusterEnd) {
      if (kept[index]![1] > clusterEnd) clusterEnd = kept[index]![1];
      cluster.push(kept[index]!);
      index += 1;
    }
    const cstart = cluster[0]![0];
    if (cursor < cstart) parts.push(text.slice(cursor, cstart));
    if (cluster.length === 1) parts.push(cluster[0]![2]);
    else {
      const secret = cluster.map((span) => [span[3], span[1]] as [number, number]).sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const [start, end] of secret) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      let pos = cstart;
      for (const [start, end] of merged) {
        if (pos < start) parts.push(text.slice(pos, start));
        parts.push(MARKER);
        pos = end;
      }
      if (pos < clusterEnd) parts.push(text.slice(pos, clusterEnd));
    }
    cursor = clusterEnd;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join("");
}

function tokenStart(value: string, end: number): number {
  let secret = end;
  while (secret > 0 && TOKEN_CHARS.has(value[secret - 1]!)) secret -= 1;
  return secret;
}

function collect(pattern: RegExp, value: string, spans: Span[], repl: (match: RegExpMatchArray) => string, secretAt: (match: RegExpMatchArray) => number): void {
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length, repl(match), secretAt(match)]);
  }
  pattern.lastIndex = 0;
}

function tokenRightOk(value: string, end: number, edges: Set<number>): boolean {
  return end === value.length || edges.has(end) || !/[A-Za-z0-9_]/.test(value[end]!);
}

function pushTokensAtEdges(value: string, spans: Span[], edges: Set<number>): void {
  const covered = new Set(spans.map((span) => span[0]));
  for (const edge of edges) {
    if (covered.has(edge) || edge >= value.length) continue;
    const head = value.slice(edge, edge + 12);
    const gh = head.length >= 4 && ["ghp", "gho", "ghu", "ghs", "ghr"].includes(head.slice(0, 3)) && head[3] === "_";
    const xox = head.length >= 5 && head.startsWith("xox") && "baprs".includes(head[3]!) && head[4] === "-";
    if (!(head.startsWith("sk-") || head.startsWith("sk_live_") || head.startsWith("github_pat_") || head.startsWith("AIza") || head.startsWith("AKIA") || head.startsWith("ASIA") || gh || xox)) continue;
    tokenBody.lastIndex = edge;
    const match = tokenBody.exec(value);
    if (!match || match.index !== edge || !tokenRightOk(value, edge + match[0].length, edges)) continue;
    spans.push([edge, edge + match[0].length, MARKER, edge]);
    covered.add(edge);
  }
  tokenBody.lastIndex = 0;
}

function pushSuffixCards(value: string, spans: Span[], covers: Span[]): void {
  // A card suffix is only exposed by a span that begins before the digit group.
  // Digit-leading spans are cards themselves; skipping them keeps this pass off
  // the long contiguous-digit shapes.
  const length = value.length;
  const ordered = covers
    .filter((span) => {
      const code = value.charCodeAt(span[0]!);
      return span[0] < length && (code < 48 || code > 57) && span[1] > span[0];
    })
    .sort((a, b) => a[0] - b[0]);
  if (ordered.length === 0) return;
  let run = 0;
  let longRun = false;
  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      run += 1;
      if (run > 4) {
        longRun = true;
        break;
      }
    } else {
      run = 0;
    }
  }
  if (!longRun) return;
  let i = 0;
  let pointer = 0;
  const digitAt = (index: number) => {
    const code = value.charCodeAt(index);
    return code >= 48 && code <= 57;
  };
  while (i < length) {
    if (!digitAt(i)) {
      i += 1;
      continue;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    const seps: string[] = [];
    const glens: number[] = [];
    while (i < length && digitAt(i)) {
      starts.push(i);
      let glen = 0;
      while (i < length && digitAt(i)) {
        glen += 1;
        i += 1;
      }
      ends.push(i);
      glens.push(glen);
      if (i + 1 < length && (value[i] === " " || value[i] === "-") && digitAt(i + 1)) {
        seps.push(value[i]!);
        i += 1;
        continue;
      }
      seps.push("");
      break;
    }
    for (let group = 0; group < glens.length; group += 1) {
      const glen = glens[group]!;
      if (glen <= 4) continue;
      const groupStart = starts[group]!;
      while (pointer < ordered.length && ordered[pointer]![1] <= groupStart) pointer += 1;
      if (pointer >= ordered.length) return;
      const cover = ordered[pointer]!;
      if (cover[0] >= groupStart || cover[1] <= groupStart) continue;
      for (const lead of [4, 8, 13, 14, 15, 16, 17, 18, 19]) {
        if (glen <= lead) continue;
        const charStart = ends[group]! - lead;
        if (charStart <= groupStart || !(cover[0] <= charStart - 1 && charStart - 1 < cover[1])) continue;
        const lengths = [lead];
        let look = group + 1;
        const sep = seps[group]!;
        while (sep !== "" && look < glens.length && seps[look - 1] === sep) {
          const candidate = lengths.concat(glens[look]!).join(",");
          if (!LAYOUT_PREFIXES.has(candidate)) break;
          lengths.push(glens[look]!);
          look += 1;
        }
        for (let size = lengths.length; size > 0; size -= 1) {
          if (!EXACT_LAYOUTS.has(lengths.slice(0, size).join(","))) continue;
          const endAt = size === 1 ? charStart + lead : ends[group + size - 1]!;
          if (endAt !== length && digitAt(endAt)) continue;
          const digits: number[] = [];
          for (let pos = charStart; pos < ends[group]!; pos += 1) if (digitAt(pos)) digits.push(value.charCodeAt(pos) - 48);
          for (let follow = group + 1; follow < group + size; follow += 1) {
            for (let pos = starts[follow]!; pos < ends[follow]!; pos += 1) digits.push(value.charCodeAt(pos) - 48);
          }
          let total = 0;
          let alt = false;
          for (let index = digits.length - 1; index >= 0; index -= 1) {
            let number = digits[index]!;
            if (alt) {
              number *= 2;
              if (number > 9) number -= 9;
            }
            total += number;
            alt = !alt;
          }
          if (total % 10 === 0) {
            spans.push([charStart, endAt, MARKER, charStart]);
            break;
          }
        }
      }
    }
  }
}

function redactText(value: string): string {
  const spans: Span[] = [];
  collect(privateKey, value, spans, () => MARKER, (match) => match.index ?? 0);
  collect(armor, value, spans, () => MARKER, (match) => match.index ?? 0);
  collect(tokens, value, spans, () => MARKER, (match) => match.index ?? 0);
  collect(awsSecret, value, spans, (match) => `${match[1] ?? ""}${MARKER}`, (match) => (match.index ?? 0) + (match[1]?.length ?? 0));
  collect(bearer, value, spans, () => `Bearer ${MARKER}`, (match) => tokenStart(value, (match.index ?? 0) + match[0].length));
  collect(basic, value, spans, () => `Basic ${MARKER}`, (match) => tokenStart(value, (match.index ?? 0) + match[0].length));
  const urls: Span[] = [];
  pushUrls(value, urls);
  spans.push(...urls);
  pushCards(value, spans);
  collect(assigned, value, spans, (match) => `${match[1] ?? ""}${MARKER}`, (match) => (match.index ?? 0) + (match[1]?.length ?? 0));
  collect(queryToken, value, spans, (match) => `${match[1] ?? ""}${MARKER}`, (match) => (match.index ?? 0) + (match[1]?.length ?? 0));
  pushEmails(value, spans, urls.map((span) => [span[0], span[1]]), spanEdges(spans));
  pushJwts(value, spans, spanEdges(spans));
  pushSuffixCards(value, spans, spans);
  pushTokensAtEdges(value, spans, spanEdges(spans));
  return applySpans(value, spans);
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
