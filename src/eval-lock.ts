/**
 * Deterministic eval-set lock and exact train/eval overlap check.
 * Scheme 1 hashes canonical JSON. Item order and object key order do not
 * change the digest. The leakage check is exact after NFC and whitespace
 * normalization. It does not fuzzy-match and it does not call user code.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { JsonValue } from "./contracts.js";
import { LoopiterError, fail } from "./utils.js";

export const EVAL_LOCK_SCHEME = 1;
/** Ids included in a text or JSON diff. The counts are never capped. */
export const EVAL_REPORT_ID_CAP = 20;
const SAFE_INTEGER_MAX = "9007199254740991";
const CONTENT_FIELDS = ["input", "expected"] as const;

export interface EvalItem {
  id: string;
  input: JsonValue;
  expected: JsonValue;
}

export interface EvalSuite {
  items: EvalItem[];
}

export interface EvalLockItem {
  id: string;
  sha256: string;
}

export interface EvalLock {
  scheme: 1;
  itemCount: number;
  sha256: string;
  items: EvalLockItem[];
}

export interface EvalLockReport {
  ok: boolean;
  scheme: 1;
  itemCount: number;
  sha256: string;
  added: number;
  removed: number;
  changed: number;
  truncated: boolean;
  addedIds: string[];
  removedIds: string[];
  changedIds: string[];
}

export interface LeakageReport {
  ok: boolean;
  trainItems: number;
  evalItems: number;
  overlapCount: number;
  idOverlapCount: number;
  contentOverlapCount: number;
  truncated: boolean;
  ids: string[];
}

export function lockEvalSet(suite: EvalSuite | unknown): EvalLock {
  return lockItems(readEvalSuite(suite).items);
}

export function verifyEvalLock(suite: EvalSuite | unknown, lock: EvalLock | unknown): EvalLockReport {
  const current = lockEvalSet(suite);
  const expected = readEvalLock(lock);
  const previous = new Map(expected.items.map((item) => [item.id, item.sha256]));
  const next = new Map(current.items.map((item) => [item.id, item.sha256]));
  const addedIds = [...next.keys()].filter((id) => !previous.has(id)).sort(compareUtf8);
  const removedIds = [...previous.keys()].filter((id) => !next.has(id)).sort(compareUtf8);
  const changedIds = [...next.keys()]
    .filter((id) => previous.has(id) && previous.get(id) !== next.get(id))
    .sort(compareUtf8);
  const added = capIds(addedIds);
  const removed = capIds(removedIds);
  const changed = capIds(changedIds);
  const same =
    current.sha256 === expected.sha256 &&
    addedIds.length === 0 &&
    removedIds.length === 0 &&
    changedIds.length === 0;
  return {
    ok: same,
    scheme: EVAL_LOCK_SCHEME,
    itemCount: current.itemCount,
    sha256: current.sha256,
    added: addedIds.length,
    removed: removedIds.length,
    changed: changedIds.length,
    truncated: added.truncated || removed.truncated || changed.truncated,
    addedIds: added.ids,
    removedIds: removed.ids,
    changedIds: changed.ids,
  };
}

export function checkEvalLeakage(
  train: EvalSuite | unknown,
  evaluation: EvalSuite | unknown,
  fields: readonly string[] = ["input", "expected"],
): LeakageReport {
  const trainItems = readEvalSuite(train).items;
  const evalItems = readEvalSuite(evaluation).items;
  const selected = readFields(fields);
  const trainIds = new Set(trainItems.map((item) => item.id));
  const hashes = new Map<string, string[]>();
  for (const item of trainItems) {
    const digest = contentHash(item, selected);
    const list = hashes.get(digest) ?? [];
    list.push(item.id);
    hashes.set(digest, list);
  }
  const idOverlap = new Set<string>();
  const contentOverlap = new Set<string>();
  for (const item of evalItems) {
    if (trainIds.has(item.id)) idOverlap.add(item.id);
    const matched = hashes.get(contentHash(item, selected));
    if (!matched) continue;
    contentOverlap.add(item.id);
    for (const id of matched) contentOverlap.add(id);
  }
  const ids = [...new Set([...idOverlap, ...contentOverlap])].sort(compareUtf8);
  const capped = capIds(ids);
  return {
    ok: ids.length === 0,
    trainItems: trainItems.length,
    evalItems: evalItems.length,
    overlapCount: ids.length,
    idOverlapCount: idOverlap.size,
    contentOverlapCount: contentOverlap.size,
    truncated: capped.truncated,
    ids: capped.ids,
  };
}

export function readEvalSuite(value: unknown): EvalSuite {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Eval set must be an object with an items array.");
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) fail("invalid_input", "Eval set must be an object with an items array.");
  const read = items.map(readEvalItem);
  const seen = new Set<string>();
  for (const item of read) {
    if (seen.has(item.id))
      fail("invalid_input", `Eval set has a duplicate id: ${quoteAscii(item.id)}`);
    seen.add(item.id);
  }
  return { items: read };
}

export function readEvalLock(value: unknown): EvalLock {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("eval_lock_invalid", "Lock file is not an eval lock.");
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "scheme")) fail("eval_lock_invalid", "Lock file is not an eval lock.");
  if (record.scheme !== EVAL_LOCK_SCHEME)
    fail("eval_lock_invalid", "Lock file uses an unsupported scheme.");
  if (
    typeof record.itemCount !== "number" ||
    !Number.isSafeInteger(record.itemCount) ||
    record.itemCount < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    !Array.isArray(record.items) ||
    record.items.length !== record.itemCount
  )
    fail("eval_lock_invalid", "Lock file is not an eval lock.");
  const items = record.items.map(readLockItem);
  for (let index = 1; index < items.length; index += 1) {
    if (compareUtf8(items[index - 1]!.id, items[index]!.id) >= 0)
      fail("eval_lock_invalid", "Lock file is not an eval lock.");
  }
  return {
    scheme: EVAL_LOCK_SCHEME,
    itemCount: record.itemCount,
    sha256: record.sha256,
    items,
  };
}

export function defaultLockPath(suitePath: string): string {
  if (suitePath.endsWith(".json")) return `${suitePath.slice(0, -5)}.lock.json`;
  return `${suitePath}.lock.json`;
}

export function quoteAscii(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function formatLockWrote(path: string, lock: EvalLock): string {
  return `eval lock wrote ${quoteAscii(path)} scheme ${lock.scheme} items ${lock.itemCount} sha256 ${lock.sha256}\n`;
}

export function formatLockText(report: EvalLockReport): string {
  if (report.ok)
    return `eval lock ok scheme ${report.scheme} items ${report.itemCount} sha256 ${report.sha256}\n`;
  return `eval lock drift added ${report.added} removed ${report.removed} changed ${report.changed} truncated ${report.truncated} addedIds ${asciiCompact(report.addedIds)} removedIds ${asciiCompact(report.removedIds)} changedIds ${asciiCompact(report.changedIds)}\n`;
}

export function formatLockJson(report: EvalLockReport): string {
  return `${asciiJson(report)}\n`;
}

export function formatLeakageText(report: LeakageReport): string {
  if (report.ok) return `eval leakage ok train ${report.trainItems} eval ${report.evalItems} overlaps 0\n`;
  return `eval leakage overlap count ${report.overlapCount} truncated ${report.truncated} ids ${asciiCompact(report.ids)}\n`;
}

export function formatLeakageJson(report: LeakageReport): string {
  return `${asciiJson(report)}\n`;
}

export function assertSafeJsonText(text: string): void {
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '"') {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      const start = index;
      if (text[index] === "-") index += 1;
      const digits = index;
      while (index < text.length && text[index]! >= "0" && text[index]! <= "9") index += 1;
      const integerEnd = index;
      let decimal = false;
      if (text[index] === ".") {
        decimal = true;
        index += 1;
        while (index < text.length && text[index]! >= "0" && text[index]! <= "9") index += 1;
      }
      if (text[index] === "e" || text[index] === "E") {
        decimal = true;
        index += 1;
        if (text[index] === "+" || text[index] === "-") index += 1;
        while (index < text.length && text[index]! >= "0" && text[index]! <= "9") index += 1;
      }
      if (!decimal && integerEnd > digits && unsafeIntegerToken(text.slice(start, integerEnd)))
        fail("invalid_input", "Eval set contains an integer outside the safe range.");
      if (index === start) index += 1;
      continue;
    }
    index += 1;
  }
}

export function runEvalCommand(args: string[]): number {
  try {
    return dispatchEval(args);
  } catch (error) {
    if (isUsageError(error)) return 2;
    if (error instanceof LoopiterError) {
      console.error(error.message);
      return 1;
    }
    console.error(error instanceof Error && error.message ? error.message : "Eval command failed.");
    return 1;
  }
}

function dispatchEval(args: string[]): number {
  const sub = args[0];
  if (!sub) return usage("Usage: loopiter eval lock|verify|leakage");
  if (sub === "lock") return commandLock(args.slice(1));
  if (sub === "verify") return commandVerify(args.slice(1));
  if (sub === "leakage") return commandLeakage(args.slice(1));
  if (sub.startsWith("--")) return usage(`Unknown option: ${sub}`);
  return usage(`Unknown eval command: ${sub}`);
}

function commandLock(args: string[]): number {
  const parsed = parseArgs(args, ["--out"], []);
  if (parsed.positionals.length !== 1) return usage("Usage: loopiter eval lock <suite> [--out <path>]");
  const suitePath = parsed.positionals[0]!;
  const out = parsed.values["--out"] ?? defaultLockPath(suitePath);
  const lock = lockEvalSet(readJson(suitePath));
  writeFileSync(out, `${asciiJson(lock)}\n`);
  process.stdout.write(formatLockWrote(out, lock));
  return 0;
}

function commandVerify(args: string[]): number {
  const parsed = parseArgs(args, ["--lock"], ["--json"]);
  if (parsed.positionals.length !== 1)
    return usage("Usage: loopiter eval verify <suite> [--lock <path>] [--json]");
  const suitePath = parsed.positionals[0]!;
  const lockPath = parsed.values["--lock"] ?? defaultLockPath(suitePath);
  const report = verifyEvalLock(readJson(suitePath), readJson(lockPath));
  process.stdout.write(parsed.switches.has("--json") ? formatLockJson(report) : formatLockText(report));
  return report.ok ? 0 : 1;
}

function commandLeakage(args: string[]): number {
  const parsed = parseArgs(args, ["--train", "--eval", "--fields"], ["--json"]);
  if (parsed.positionals.length !== 0)
    return usage("Usage: loopiter eval leakage --train <file> --eval <file> [--fields <names>] [--json]");
  if (!parsed.values["--train"] || !parsed.values["--eval"])
    return usage("Usage: loopiter eval leakage --train <file> --eval <file> [--fields <names>] [--json]");
  const fields = parsed.values["--fields"] === undefined ? undefined : splitFields(parsed.values["--fields"]);
  const report = checkEvalLeakage(
    readJson(parsed.values["--train"]),
    readJson(parsed.values["--eval"]),
    fields,
  );
  process.stdout.write(
    parsed.switches.has("--json") ? formatLeakageJson(report) : formatLeakageText(report),
  );
  return report.ok ? 0 : 1;
}

function splitFields(value: string): string[] {
  if (value.length === 0) fail("invalid_input", "--fields requires a value.");
  return value.split(",");
}

function parseArgs(args: string[], values: string[], switches: string[]): {
  positionals: string[];
  values: Record<string, string>;
  switches: Set<string>;
} {
  const seen = new Set<string>();
  const positionals: string[] = [];
  const parsed: Record<string, string> = {};
  const found = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option.startsWith("--")) {
      if (seen.has(option)) return stop(`Duplicate option: ${option}`);
      seen.add(option);
      if (switches.includes(option)) {
        found.add(option);
        continue;
      }
      if (!values.includes(option)) return stop(`Unknown option: ${option}`);
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) return stop(`${option} requires a value.`);
      parsed[option] = next;
      index += 1;
      continue;
    }
    positionals.push(option);
  }
  return { positionals, values: parsed, switches: found };
}

function stop(message: string): never {
  console.error(message);
  const error = new Error(message);
  (error as { usage?: boolean }).usage = true;
  throw error;
}

function isUsageError(error: unknown): boolean {
  return !!error && typeof error === "object" && "usage" in error && error.usage === true;
}

function usage(message: string): number {
  console.error(message);
  return 2;
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) fail("invalid_input", `Missing file: ${quoteAscii(path)}`);
    fail("invalid_input", `File is not JSON: ${quoteAscii(path)}`);
  }
  try {
    assertSafeJsonText(text);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof LoopiterError) throw error;
    fail("invalid_input", `File is not JSON: ${quoteAscii(path)}`);
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function lockItems(items: EvalItem[]): EvalLock {
  const ordered = [...items].sort((left, right) => compareUtf8(left.id, right.id));
  const locked = ordered.map((item) => ({
    id: item.id,
    sha256: sha256(canonicalJson(itemRecord(item))),
  }));
  return {
    scheme: EVAL_LOCK_SCHEME,
    itemCount: locked.length,
    sha256: sha256(canonicalJson(ordered.map(itemRecord))),
    items: locked,
  };
}

function itemRecord(item: EvalItem): { expected: JsonValue; id: string; input: JsonValue } {
  return { expected: item.expected, id: item.id, input: item.input };
}

function readEvalItem(value: unknown): EvalItem {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Eval item must be an object.");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "id" && key !== "input" && key !== "expected")
      fail("invalid_input", "Eval item has an unknown field.");
  }
  if (typeof record.id !== "string" || !record.id.trim() || record.id.includes("\0"))
    fail("invalid_input", "Eval item id must be a nonempty string.");
  if (!Object.hasOwn(record, "input")) fail("invalid_input", "Eval item is missing input.");
  if (!Object.hasOwn(record, "expected")) fail("invalid_input", "Eval item is missing expected.");
  return {
    id: record.id,
    input: jsonValue(record.input),
    expected: jsonValue(record.expected),
  };
}

function readLockItem(value: unknown): EvalLockItem {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("eval_lock_invalid", "Lock file is not an eval lock.");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id.trim() ||
    record.id.includes("\0") ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256)
  )
    fail("eval_lock_invalid", "Lock file is not an eval lock.");
  return { id: record.id, sha256: record.sha256 };
}

function readFields(fields: readonly string[]): string[] {
  if (fields.length === 0) fail("invalid_input", "--fields requires a value.");
  const seen = new Set<string>();
  for (const field of fields) {
    if (!CONTENT_FIELDS.includes(field as (typeof CONTENT_FIELDS)[number]))
      fail("invalid_input", `Unknown field: ${quoteAscii(field)}`);
    if (seen.has(field)) fail("invalid_input", `Duplicate field: ${quoteAscii(field)}`);
    seen.add(field);
  }
  return [...fields];
}

function contentHash(item: EvalItem, fields: readonly string[]): string {
  const payload: Record<string, JsonValue> = {};
  for (const field of fields) payload[field] = normalizeValue(item[field as "input" | "expected"]);
  return sha256(canonicalJson(payload));
}

function normalizeValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value !== null && typeof value === "object") {
    const next = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value)) next[key] = normalizeValue(value[key]!);
    return next;
  }
  return value;
}

/** The only characters treated as whitespace. Trim uses this set, not String.trim. */
const WHITESPACE_CODES = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
for (let code = 0x2000; code <= 0x200a; code += 1) WHITESPACE_CODES.add(code);

function normalizeText(value: string): string {
  assertUnicode(value);
  let text = "";
  let pending = false;
  for (const character of value.normalize("NFC")) {
    if (WHITESPACE_CODES.has(character.codePointAt(0)!)) {
      pending = true;
      continue;
    }
    if (pending && text.length > 0) text += " ";
    pending = false;
    text += character;
  }
  return text;
}

function capIds(ids: string[]): { ids: string[]; truncated: boolean } {
  if (ids.length <= EVAL_REPORT_ID_CAP) return { ids, truncated: false };
  return { ids: ids.slice(0, EVAL_REPORT_ID_CAP), truncated: true };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asciiCompact(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function compareUtf8(left: string, right: string): number {
  assertUnicode(left);
  assertUnicode(right);
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function unsafeIntegerToken(token: string): boolean {
  const digits = (token.startsWith("-") ? token.slice(1) : token).replace(/^0+/, "") || "0";
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length > SAFE_INTEGER_MAX.length) return true;
  if (digits.length < SAFE_INTEGER_MAX.length) return false;
  return digits > SAFE_INTEGER_MAX;
}

export function canonicalJson(value: unknown): string {
  return encodeJson(jsonValue(value), new Set());
}

function jsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") {
    assertUnicode(value);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_input", "Eval set contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("invalid_input", "Eval set contains a value that is not JSON.");
    if (Object.keys(value).length !== value.length)
      fail("invalid_input", "Eval set contains a value that is not JSON.");
    seen.add(value);
    const next = value.map((item) => jsonValue(item, seen));
    seen.delete(value);
    return next;
  }
  if (!value || typeof value !== "object")
    fail("invalid_input", "Eval set contains a value that is not JSON.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid_input", "Eval set contains a value that is not JSON.");
  if (seen.has(value)) fail("invalid_input", "Eval set contains a value that is not JSON.");
  seen.add(value);
  const next = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    assertUnicode(key);
    next[key] = jsonValue((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return next;
}

function encodeJson(value: JsonValue, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("invalid_input", "Eval set contains a value that is not JSON.");
    seen.add(value);
    const text = `[${value.map((item) => encodeJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return text;
  }
  if (seen.has(value)) fail("invalid_input", "Eval set contains a value that is not JSON.");
  seen.add(value);
  const keys = Object.keys(value).sort(compareUtf8);
  const text = `{${keys
    .map((key) => `${canonicalString(key)}:${encodeJson(value[key]!, seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return text;
}

function canonicalNumber(value: number): string {
  if (Object.is(value, -0) || value === 0) return "0";
  if (Number.isSafeInteger(value)) return String(value);
  return JSON.stringify(value);
}

function canonicalString(value: string): string {
  assertUnicode(value);
  let text = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') text += '\\"';
    else if (character === "\\") text += "\\\\";
    else if (character === "\b") text += "\\b";
    else if (character === "\f") text += "\\f";
    else if (character === "\n") text += "\\n";
    else if (character === "\r") text += "\\r";
    else if (character === "\t") text += "\\t";
    else if (code < 0x20 || code === 0x2028 || code === 0x2029)
      text += `\\u${code.toString(16).padStart(4, "0")}`;
    else text += character;
  }
  return `${text}"`;
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        fail("invalid_input", "Eval set contains invalid Unicode.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("invalid_input", "Eval set contains invalid Unicode.");
    }
  }
}
