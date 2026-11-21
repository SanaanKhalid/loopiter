import type { ControlRecord, JsonObject, JsonValue } from "./contracts.js";
import type { StoreTransaction } from "./store.js";
import { fail, finite, hash, nonempty, object, timestamp } from "./utils.js";
import { fields as allow } from "./validation.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
const ANSWER_FIELDS = ["namespace", "answer", "episodeId", "artifactVersion"];
const FEEDBACK_FIELDS = ["answerId", "rating", "edit", "note"];
const LIMITS = {
  namespace: 200,
  answer: 100_000,
  episodeId: 200,
  artifactVersion: 200,
  answerId: 80,
  edit: 100_000,
  note: 4_000,
};

export const FEEDBACK_CURSOR_ID = "feedback-cursor";

export interface ServedAnswerInput {
  namespace: string;
  answer: string;
  episodeId?: string;
  artifactVersion?: string;
}

export type FeedbackRating =
  | { kind: "numeric"; value: number }
  | { kind: "thumbs"; value: "up" | "down" };

export interface FeedbackInput {
  answerId: string;
  rating?: FeedbackRating;
  edit?: string;
  note?: string;
}

export interface FeedbackCursor {
  position: string | null;
  previous: string | null;
  promotionId: string | null;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") fail("invalid_input", `${name} must be text.`);
  nonempty(value, name);
  if (value.length > max) fail("invalid_input", `${name} exceeds ${max} characters.`);
  if (CONTROL.test(value)) fail("invalid_input", `${name} contains a control character.`);
  return value;
}

/** Stable id for one served answer. The same inputs produce the same id in Node and Python. */
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
  return `ans_${hash(canonical)}`;
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

/** Fail closed on unknown fields, length, and control characters. Rating, edit, or both. */
export function feedbackInput(raw: unknown): FeedbackInput {
  object(raw, "feedback");
  allow(raw, FEEDBACK_FIELDS);
  const answerId = text(raw.answerId, "answerId", LIMITS.answerId);
  const parsed: FeedbackInput = { answerId };
  if (raw.rating !== undefined) parsed.rating = rating(raw.rating);
  if (raw.edit !== undefined) parsed.edit = text(raw.edit, "edit", LIMITS.edit);
  if (raw.note !== undefined) parsed.note = text(raw.note, "note", LIMITS.note);
  if (parsed.rating === undefined && parsed.edit === undefined)
    fail("invalid_input", "Feedback needs a rating or a corrected edit.");
  return parsed;
}

export async function persistFeedback(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  input: FeedbackInput,
): Promise<{ id: string; recordedAt: string }> {
  const id = feedbackRecordId(input);
  const existing = (await tx.get("coordination", id)) as ControlRecord | undefined;
  if (existing) return { id, recordedAt: String(existing.data.recordedAt) };
  const data: JsonObject = {
    kind: "feedback",
    answerId: input.answerId,
    recordedAt: now,
  };
  if (input.rating) data.rating = input.rating as unknown as JsonValue;
  if (input.edit !== undefined) data.edit = input.edit;
  if (input.note !== undefined) data.note = input.note;
  await writeCoordination(tx, namespace, now, id, data);
  return { id, recordedAt: now };
}

export function feedbackRecordId(input: FeedbackInput): string {
  const canonical: JsonObject = { answerId: input.answerId };
  if (input.rating) canonical.rating = input.rating as unknown as JsonValue;
  if (input.edit !== undefined) canonical.edit = input.edit;
  if (input.note !== undefined) canonical.note = input.note;
  return `feedback:${hash(canonical)}`;
}

export function emptyFeedbackCursor(): FeedbackCursor {
  return { position: null, previous: null, promotionId: null };
}

export function advanceFeedbackCursor(
  cursor: FeedbackCursor,
  rows: { id: string; recordedAt: string }[],
  promotionId: string,
): FeedbackCursor {
  nonempty(promotionId, "promotionId");
  if (cursor.promotionId === promotionId) return cursor;
  const latest = [...rows].sort((a, b) =>
    a.recordedAt < b.recordedAt
      ? -1
      : a.recordedAt > b.recordedAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  ).at(-1);
  if (!latest) return cursor;
  return { position: latest.id, previous: cursor.position, promotionId };
}

export function rewindFeedbackCursor(
  cursor: FeedbackCursor,
  promotionId: string,
): FeedbackCursor {
  if (cursor.promotionId !== promotionId) return cursor;
  return { position: cursor.previous, previous: null, promotionId: null };
}

function sameCursor(a: FeedbackCursor, b: FeedbackCursor): boolean {
  return a.position === b.position && a.previous === b.previous && a.promotionId === b.promotionId;
}

async function listCoordination(tx: StoreTransaction): Promise<ControlRecord[]> {
  const rows: ControlRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await tx.list("coordination", { limit: 1000, ...(cursor ? { cursor } : {}) });
    rows.push(...(page.items as ControlRecord[]));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
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
  const updatedAt = old && old.updatedAt > now ? old.updatedAt : now;
  const row: ControlRecord = {
    id,
    namespace,
    revision: (old?.revision ?? 0) + 1,
    createdAt: old?.createdAt ?? now,
    updatedAt,
    format: 1,
    data,
  };
  if (old) await tx.replace("coordination", row, old.revision);
  else await tx.insert("coordination", row);
}

export async function applyFeedbackCursor(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  action: "promote" | "rollback",
  promotionId: string,
): Promise<FeedbackCursor> {
  const rows = await listCoordination(tx);
  const current = rows.find((row) => row.id === FEEDBACK_CURSOR_ID);
  const cursor = readCursor(current?.data);
  const feedback = rows.flatMap((row) => {
    if (row.data.kind !== "feedback" || typeof row.data.recordedAt !== "string") return [];
    return [{ id: row.id, recordedAt: row.data.recordedAt }];
  });
  const next =
    action === "promote"
      ? advanceFeedbackCursor(cursor, feedback, promotionId)
      : rewindFeedbackCursor(cursor, promotionId);
  if (!sameCursor(cursor, next))
    await writeCoordination(tx, namespace, now, FEEDBACK_CURSOR_ID, {
      kind: "feedback-cursor",
      position: next.position,
      previous: next.previous,
      promotionId: next.promotionId,
    });
  return next;
}

function readCursor(data: JsonObject | undefined): FeedbackCursor {
  if (!data) return emptyFeedbackCursor();
  const position = data.position;
  const previous = data.previous;
  const promotionId = data.promotionId;
  return {
    position: typeof position === "string" ? position : null,
    previous: typeof previous === "string" ? previous : null,
    promotionId: typeof promotionId === "string" ? promotionId : null,
  };
}

export function isPromotion(state: string, reason: string): boolean {
  return (
    state === "completed" &&
    (reason === "offline_pass_and_production_limits_met_not_causal_proof" ||
      reason === "canary_promoted")
  );
}
