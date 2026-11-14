import type { FeedbackLoop } from "../feedback-loop.js";
import type { HistoricalRecord, JsonObject, JsonValue } from "../contracts.js";
import {
  fail,
  integer,
  nonempty,
  object,
  stableJson,
  timestamp,
} from "../utils.js";

const statuses = ["success", "partial", "error", "abstained", "dropped"] as const;
const usageStates = ["known", "estimated", "unknown"] as const;
const replayReason = "imported-for-regression";

export interface ImportRecord {
  idempotencyKey: string;
  occurredAt: string;
  status: (typeof statuses)[number];
  parentId?: string;
  stageId?: string;
  versions?: { prompt?: string; model?: string; config?: string };
  usage: { state: (typeof usageStates)[number]; tokens?: number };
  replay?: { eligible?: boolean; reason?: string };
}

export interface ImportResult {
  accepted: number;
  conflicts: number;
  rejected: number;
}

/** Store a batch of historical records. Does not run the application or attach a release. */
export async function importBatch(
  loop: FeedbackLoop,
  records: readonly unknown[],
): Promise<ImportResult> {
  if (!Array.isArray(records))
    throw new TypeError("importBatch requires an array of records.");
  const result: ImportResult = { accepted: 0, conflicts: 0, rejected: 0 };
  for (const record of records) {
    let body: JsonObject;
    try {
      body = normalize(record);
    } catch {
      result.rejected += 1;
      continue;
    }
    const outcome = await loop.store.transaction(loop.namespace, async (tx) => {
      const existing = await tx.get("historical", String(body.idempotencyKey));
      if (existing) {
        return stableJson(existing.original) === stableJson(body) ? "accepted" : "conflicts";
      }
      const row: HistoricalRecord = {
        id: String(body.idempotencyKey),
        namespace: loop.namespace,
        revision: 1,
        createdAt: String(body.occurredAt),
        updatedAt: String(body.occurredAt),
        original: body,
      };
      await tx.insert("historical", row);
      return "accepted";
    });
    result[outcome] += 1;
  }
  return result;
}

function normalize(record: unknown): JsonObject {
  object(record, "import record");
  const allowed = [
    "idempotencyKey",
    "occurredAt",
    "status",
    "parentId",
    "stageId",
    "versions",
    "usage",
    "replay",
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail("invalid_input", "Unknown import field.");
  }
  nonempty(record.idempotencyKey, "idempotencyKey");
  timestamp(record.occurredAt, "occurredAt");
  if (!statuses.includes(record.status as (typeof statuses)[number]))
    fail("invalid_input", "Invalid import status.");
  const body: JsonObject = {
    idempotencyKey: record.idempotencyKey,
    occurredAt: record.occurredAt,
    status: record.status as JsonValue,
  };
  for (const key of ["parentId", "stageId"] as const) {
    if (record[key] !== undefined) {
      nonempty(record[key], key);
      body[key] = record[key];
    }
  }
  if (record.versions !== undefined) body.versions = versions(record.versions);
  body.usage = usage(record.usage);
  body.replay = replay(record.replay);
  return body;
}

function versions(value: unknown): JsonObject {
  object(value, "versions");
  const body: JsonObject = {};
  for (const key of Object.keys(value)) {
    if (key !== "prompt" && key !== "model" && key !== "config")
      fail("invalid_input", "Unknown version field.");
  }
  for (const key of ["prompt", "model", "config"] as const) {
    if (value[key] !== undefined) {
      nonempty(value[key], key);
      body[key] = value[key];
    }
  }
  return body;
}

function usage(value: unknown): JsonObject {
  object(value, "usage");
  for (const key of Object.keys(value)) {
    if (key !== "state" && key !== "tokens") fail("invalid_input", "Unknown usage field.");
  }
  if (!usageStates.includes(value.state as (typeof usageStates)[number]))
    fail("invalid_input", "Invalid usage state.");
  if (value.state === "unknown") {
    if (value.tokens !== undefined)
      fail("invalid_input", "Unknown usage cannot be stored as a token count.");
    return { state: "unknown" };
  }
  const body: JsonObject = { state: value.state as JsonValue };
  if (value.tokens !== undefined) {
    integer(value.tokens, "tokens", 0);
    body.tokens = value.tokens;
  }
  return body;
}

function replay(value: unknown): JsonObject {
  if (value === undefined) return { eligible: false };
  object(value, "replay");
  for (const key of Object.keys(value)) {
    if (key !== "eligible" && key !== "reason") fail("invalid_input", "Unknown replay field.");
  }
  const eligible = value.eligible === undefined ? false : value.eligible;
  if (typeof eligible !== "boolean") fail("invalid_input", "replay.eligible must be boolean.");
  if (!eligible) {
    const body: JsonObject = { eligible: false };
    if (value.reason !== undefined) {
      nonempty(value.reason, "replay.reason");
      body.reason = value.reason;
    }
    return body;
  }
  nonempty(value.reason, "replay.reason");
  if (value.reason !== replayReason)
    fail("invalid_input", "Replay reason is not allowed for an imported row.");
  return { eligible: true, reason: replayReason };
}
