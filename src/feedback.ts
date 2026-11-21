import { createHash } from "node:crypto";
import type { ControlRecord, JsonObject, JsonValue } from "./contracts.js";
import { canonicalJson } from "./eval-lock.js";
import type { StoreTransaction } from "./store.js";
import { fail, finite, hash, LoopiterError, object, timestamp } from "./utils.js";
import { fields as allow } from "./validation.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Shared with Python. U+0085 is blank here so a next-line-only string is empty in both SDKs. */
const BLANK = new Set(
  ["\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u0020", "\u0085", "\u00a0", "\u1680",
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008",
    "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"],
);
const ANSWER_FIELDS = ["namespace", "answer", "episodeId", "artifactVersion"];
const FEEDBACK_FIELDS = ["answerId", "target", "rating", "edit", "note"];
const LIMITS = {
  namespace: 200,
  answer: 100_000,
  episodeId: 200,
  artifactVersion: 200,
  answerId: 80,
  edit: 100_000,
  note: 4_000,
  targetKind: 64,
  targetKey: 200,
};

export interface ServedAnswerInput {
  namespace: string;
  answer: string;
  episodeId?: string;
  artifactVersion?: string;
}

export interface FeedbackTarget {
  kind: string;
  key: string;
}

export type FeedbackRating =
  | { kind: "numeric"; value: number }
  | { kind: "thumbs"; value: "up" | "down" };

export interface FeedbackInput {
  answerId: string;
  target: FeedbackTarget;
  rating?: FeedbackRating;
  edit?: string;
  note?: string;
}

export interface FeedbackPoint {
  id: string | null;
  recordedAt: string | null;
  /** Monotonic per-target order. Null means no feedback has been seen. */
  seq: number | null;
}

export interface FeedbackCursor {
  position: string | null;
  positionAt: string | null;
  seq: number | null;
  previous: string | null;
  previousAt: string | null;
  previousSeq: number | null;
  promotionId: string | null;
}

function codePoints(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function blank(value: string): boolean {
  if (value.length === 0) return true;
  for (const character of value) if (!BLANK.has(character)) return false;
  return true;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") fail("invalid_input", `${name} must be text.`);
  if (CONTROL.test(value)) fail("invalid_input", `${name} contains a control character.`);
  if (blank(value)) fail("invalid_input", `${name} must be nonempty text.`);
  if (codePoints(value) > max) fail("invalid_input", `${name} exceeds ${max} code points.`);
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Scope key shared with the controller target lock. */
export function targetScope(target: FeedbackTarget): string {
  return `target:${hash(target)}`;
}

export function feedbackCursorId(scope: string): string {
  return `feedback-cursor:${scope}`;
}

export function feedbackHeadId(scope: string): string {
  return `feedback-head:${scope}`;
}

/** Stable id for one served answer. Canonical JSON matches the eval-set lock. */
export function servedAnswerId(raw: unknown): string {
  object(raw, "served answer");
  allow(raw, ANSWER_FIELDS);
  const canonical: Record<string, string> = {
    namespace: text(raw.namespace, "namespace", LIMITS.namespace),
    answer: text(raw.answer, "answer", LIMITS.answer),
  };
  if (raw.episodeId !== undefined)
    canonical.episodeId = text(raw.episodeId, "episodeId", LIMITS.episodeId);
  if (raw.artifactVersion !== undefined)
    canonical.artifactVersion = text(
      raw.artifactVersion,
      "artifactVersion",
      LIMITS.artifactVersion,
    );
  return `ans_${digest(canonical)}`;
}

function rating(value: unknown): FeedbackRating {
  object(value, "rating");
  allow(value, ["kind", "value"]);
  if (value.kind === "numeric") {
    finite(value.value, "rating", 0);
    if (value.value > 1) fail("invalid_input", "Numeric rating must be from 0 to 1.");
    return { kind: "numeric", value: value.value };
  }
  if (value.kind === "thumbs") {
    if (value.value !== "up" && value.value !== "down")
      fail("invalid_input", "Thumbs rating must be up or down.");
    return { kind: "thumbs", value: value.value };
  }
  fail("invalid_input", "Rating kind must be numeric or thumbs.");
}

function targetOf(value: unknown): FeedbackTarget {
  object(value, "target");
  allow(value, ["kind", "key"]);
  return {
    kind: text(value.kind, "target.kind", LIMITS.targetKind),
    key: text(value.key, "target.key", LIMITS.targetKey),
  };
}

/** Fail closed on unknown fields, length, and control characters. Rating, edit, or both. */
export function feedbackInput(raw: unknown): FeedbackInput {
  object(raw, "feedback");
  allow(raw, FEEDBACK_FIELDS);
  const parsed: FeedbackInput = {
    answerId: text(raw.answerId, "answerId", LIMITS.answerId),
    target: targetOf(raw.target),
  };
  if (raw.rating !== undefined) parsed.rating = rating(raw.rating);
  if (raw.edit !== undefined) parsed.edit = text(raw.edit, "edit", LIMITS.edit);
  if (raw.note !== undefined) parsed.note = text(raw.note, "note", LIMITS.note);
  if (parsed.rating === undefined && parsed.edit === undefined)
    fail("invalid_input", "Feedback needs a rating or a corrected edit.");
  return parsed;
}

export function feedbackRecordId(input: FeedbackInput): string {
  const canonical: JsonObject = {
    answerId: input.answerId,
    target: { kind: input.target.kind, key: input.target.key },
  };
  if (input.rating) canonical.rating = input.rating as unknown as JsonValue;
  if (input.edit !== undefined) canonical.edit = input.edit;
  if (input.note !== undefined) canonical.note = input.note;
  return `feedback:${digest(canonical)}`;
}

export function emptyFeedbackCursor(): FeedbackCursor {
  return {
    position: null,
    positionAt: null,
    seq: null,
    previous: null,
    previousAt: null,
    previousSeq: null,
    promotionId: null,
  };
}

/** Stored sequence. Missing is allowed only when `required` is false. */
function sequence(value: unknown, name: string, required = false): number | null {
  if (value === null || value === undefined) {
    if (required) fail("invalid_state", `${name} must be an integer >= 1.`);
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  )
    fail("invalid_state", `${name} must be an integer >= 1.`);
  return value;
}

function storedTime(value: string, name: string): void {
  try {
    timestamp(value, name);
  } catch (error) {
    if (error instanceof LoopiterError && error.code === "invalid_input")
      fail("invalid_state", `${name} must be an ISO UTC timestamp ending in Z.`);
    throw error;
  }
}

function nullableId(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || blank(value))
    fail("invalid_state", `${name} must be a string or null.`);
  return value;
}

const CURSOR_FIELDS = [
  "kind",
  "position",
  "positionAt",
  "seq",
  "previous",
  "previousAt",
  "previousSeq",
  "promotionId",
];

function storedFields(data: JsonObject, allowed: string[]): void {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    fail("invalid_state", "Stored feedback record is malformed.");
  for (const key of Object.keys(data))
    if (!allowed.includes(key)) fail("invalid_state", `Stored feedback field is unknown: ${key}`);
  for (const key of allowed)
    if (!Object.hasOwn(data, key)) fail("invalid_state", `Stored feedback field is missing: ${key}`);
}

function readCursor(data: JsonObject | undefined): FeedbackCursor {
  if (!data) return emptyFeedbackCursor();
  storedFields(data, CURSOR_FIELDS);
  if (data.kind !== "feedback-cursor") fail("invalid_state", "Feedback cursor kind is wrong.");
  const position = nullableId(data.position, "position");
  const previous = nullableId(data.previous, "previous");
  const promotionId = nullableId(data.promotionId, "promotionId");
  const positionAt = nullableId(data.positionAt, "positionAt");
  const previousAt = nullableId(data.previousAt, "previousAt");
  const seq = sequence(data.seq, "seq");
  const previousSeq = sequence(data.previousSeq, "previousSeq");
  if (positionAt !== null) storedTime(positionAt, "positionAt");
  if (previousAt !== null) storedTime(previousAt, "previousAt");
  if ((position === null) !== (positionAt === null) || (position === null) !== (seq === null))
    fail("invalid_state", "Feedback cursor position is incomplete.");
  if (
    (previous === null) !== (previousAt === null) ||
    (previous === null) !== (previousSeq === null)
  )
    fail("invalid_state", "Feedback cursor previous position is incomplete.");
  return { position, positionAt, seq, previous, previousAt, previousSeq, promotionId };
}

export async function readFeedbackHead(
  tx: StoreTransaction,
  scope: string,
): Promise<FeedbackPoint> {
  const row = (await tx.get("coordination", feedbackHeadId(scope))) as ControlRecord | undefined;
  if (!row) return { id: null, recordedAt: null, seq: null };
  storedFields(row.data, ["kind", "id", "recordedAt", "seq"]);
  if (row.data.kind !== "feedback-head") fail("invalid_state", "Feedback head kind is wrong.");
  if (typeof row.data.id !== "string" || typeof row.data.recordedAt !== "string")
    fail("invalid_state", "Feedback head is malformed.");
  storedTime(row.data.recordedAt, "recordedAt");
  return { id: row.data.id, recordedAt: row.data.recordedAt, seq: sequence(row.data.seq, "seq", true) };
}

function later(next: FeedbackPoint, current: FeedbackPoint): boolean {
  const seen = sequence(next.seq, "seq");
  const held = sequence(current.seq, "seq");
  if (seen === null) return false;
  if (held === null) return true;
  return seen > held;
}

export function advanceFeedbackCursor(
  cursor: FeedbackCursor,
  seen: FeedbackPoint,
  promotionId: string,
): FeedbackCursor {
  if (typeof promotionId !== "string" || blank(promotionId))
    fail("invalid_input", "promotionId must be nonempty text.");
  if (cursor.promotionId === promotionId) return cursor;
  if (!later(seen, { id: cursor.position, recordedAt: cursor.positionAt, seq: cursor.seq }))
    return {
      ...cursor,
      previous: cursor.position,
      previousAt: cursor.positionAt,
      previousSeq: cursor.seq,
      promotionId,
    };
  return {
    position: seen.id,
    positionAt: seen.recordedAt,
    seq: seen.seq,
    previous: cursor.position,
    previousAt: cursor.positionAt,
    previousSeq: cursor.seq,
    promotionId,
  };
}

export function rewindFeedbackCursor(
  cursor: FeedbackCursor,
  promotionId: string,
): FeedbackCursor {
  if (cursor.promotionId !== promotionId) return cursor;
  return {
    position: cursor.previous,
    positionAt: cursor.previousAt,
    seq: cursor.previousSeq,
    previous: null,
    previousAt: null,
    previousSeq: null,
    promotionId: null,
  };
}

function sameCursor(a: FeedbackCursor, b: FeedbackCursor): boolean {
  return (
    a.position === b.position &&
    a.positionAt === b.positionAt &&
    a.seq === b.seq &&
    a.previous === b.previous &&
    a.previousAt === b.previousAt &&
    a.previousSeq === b.previousSeq &&
    a.promotionId === b.promotionId
  );
}

async function writeCoordination(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  id: string,
  data: JsonObject,
): Promise<void> {
  timestamp(now, "clock");
  const old = (await tx.get("coordination", id)) as ControlRecord | undefined;
  const row: ControlRecord = {
    id,
    namespace,
    revision: (old?.revision ?? 0) + 1,
    createdAt: old?.createdAt ?? now,
    updatedAt: old && old.updatedAt > now ? old.updatedAt : now,
    format: 1,
    data,
  };
  if (old) await tx.replace("coordination", row, old.revision);
  else await tx.insert("coordination", row);
}

function cursorData(cursor: FeedbackCursor): JsonObject {
  return {
    kind: "feedback-cursor",
    position: cursor.position,
    positionAt: cursor.positionAt,
    seq: cursor.seq,
    previous: cursor.previous,
    previousAt: cursor.previousAt,
    previousSeq: cursor.previousSeq,
    promotionId: cursor.promotionId,
  };
}

export async function promoteFeedbackCursor(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  scope: string,
  promotionId: string,
  seen: FeedbackPoint,
): Promise<FeedbackCursor> {
  const id = feedbackCursorId(scope);
  const current = (await tx.get("coordination", id)) as ControlRecord | undefined;
  const cursor = readCursor(current?.data);
  const next = advanceFeedbackCursor(cursor, seen, promotionId);
  if (!sameCursor(cursor, next)) await writeCoordination(tx, namespace, now, id, cursorData(next));
  return next;
}

/** Rewind when this candidate is the one the cursor's promoting run selected. */
export async function rewindPromotedCursor(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  candidate: { id: string; target: FeedbackTarget },
): Promise<FeedbackCursor> {
  const scope = targetScope(candidate.target);
  const id = feedbackCursorId(scope);
  const current = (await tx.get("coordination", id)) as ControlRecord | undefined;
  let cursor: FeedbackCursor;
  try {
    cursor = readCursor(current?.data);
  } catch (error) {
    if (error instanceof LoopiterError && error.code === "invalid_state")
      return emptyFeedbackCursor();
    throw error;
  }
  if (!cursor.promotionId) return cursor;
  const run = (await tx.get("runs", cursor.promotionId)) as ControlRecord | undefined;
  if (run?.data.selectedId !== candidate.id) return cursor;
  const next = rewindFeedbackCursor(cursor, cursor.promotionId);
  if (!sameCursor(cursor, next)) await writeCoordination(tx, namespace, now, id, cursorData(next));
  return next;
}

export async function persistFeedback(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  input: FeedbackInput,
): Promise<{ id: string; recordedAt: string }> {
  const id = feedbackRecordId(input);
  const existing = (await tx.get("coordination", id)) as ControlRecord | undefined;
  if (existing) {
    sequence(existing.data.seq, "seq", true);
    return { id, recordedAt: String(existing.data.recordedAt) };
  }
  const scope = targetScope(input.target);
  const head = await readFeedbackHead(tx, scope);
  const seq = (head.seq ?? 0) + 1;
  const data: JsonObject = {
    kind: "feedback",
    answerId: input.answerId,
    target: { kind: input.target.kind, key: input.target.key },
    recordedAt: now,
    seq,
  };
  if (input.rating) data.rating = input.rating as unknown as JsonValue;
  if (input.edit !== undefined) data.edit = input.edit;
  if (input.note !== undefined) data.note = input.note;
  await writeCoordination(tx, namespace, now, id, data);
  await writeCoordination(tx, namespace, now, feedbackHeadId(scope), {
    kind: "feedback-head",
    id,
    recordedAt: now,
    seq,
  });
  return { id, recordedAt: now };
}

export function isPromotion(state: string, reason: string): boolean {
  return (
    state === "completed" &&
    (reason === "offline_pass_and_production_limits_met_not_causal_proof" ||
      reason === "canary_promoted")
  );
}
