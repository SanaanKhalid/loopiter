/**
 * Seeded pool splits. Held-out rows are a different type from pool rows, so
 * they cannot be passed to the dataset builder.
 */
import type { DatasetRow, DatasetSnapshot, JsonValue } from "../../src/index.js";
import { mulberry32, shuffle } from "../kb-qa/stats.js";
import { TRUSTED_SOURCE } from "./constants.js";

export interface SplitSizes {
  optimization: number;
  validation: number;
  audit: number;
  production: number;
  heldOut: number;
}

export interface PoolRow<T extends { id: string }> {
  readonly role: "pool";
  readonly partition: "optimization" | "validation" | "audit" | "production";
  readonly example: T;
}

export interface HeldOutRow<T extends { id: string }> {
  readonly role: "held-out";
  readonly example: T;
}

export interface PublicSplit<T extends { id: string }> {
  seed: number;
  optimization: PoolRow<T>[];
  validation: PoolRow<T>[];
  audit: PoolRow<T>[];
  production: PoolRow<T>[];
  heldOut: HeldOutRow<T>[];
}

const DATES = {
  optimization: "2026-01-15T12:00:00.000Z",
  validation: "2026-02-15T12:00:00.000Z",
  audit: "2026-03-15T12:00:00.000Z",
} as const;

export function buildSeededSplit<T extends { id: string }>(input: {
  pool: readonly T[];
  heldOut: readonly T[];
  seed: number;
  sizes: SplitSizes;
}): PublicSplit<T> {
  if (!Number.isInteger(input.seed)) throw new Error("Split seed must be an integer.");
  for (const [name, size] of Object.entries(input.sizes)) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error(`Split size ${name} must be a positive integer.`);
  }
  const poolIds = new Set<string>();
  for (const row of input.pool) {
    if (poolIds.has(row.id)) throw new Error(`Duplicate pool id ${row.id}.`);
    poolIds.add(row.id);
  }
  const heldIds = new Set<string>();
  for (const row of input.heldOut) {
    if (heldIds.has(row.id)) throw new Error(`Duplicate held-out id ${row.id}.`);
    if (poolIds.has(row.id))
      throw new Error(`Held-out id ${row.id} is also in the pool.`);
    heldIds.add(row.id);
  }
  const need =
    input.sizes.optimization +
    input.sizes.validation +
    input.sizes.audit +
    input.sizes.production;
  if (input.pool.length < need)
    throw new Error(`Pool has ${input.pool.length} rows; ${need} are required.`);
  if (input.heldOut.length < input.sizes.heldOut)
    throw new Error(
      `Held-out source has ${input.heldOut.length} rows; ${input.sizes.heldOut} are required.`,
    );
  const ordered = shuffle(input.pool, mulberry32(input.seed));
  let cursor = 0;
  const take = (
    partition: PoolRow<T>["partition"],
    count: number,
  ): PoolRow<T>[] => {
    const slice = ordered.slice(cursor, cursor + count);
    cursor += count;
    return slice.map((example) => ({ role: "pool", partition, example }));
  };
  const heldSorted = [...input.heldOut].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return {
    seed: input.seed,
    optimization: take("optimization", input.sizes.optimization),
    validation: take("validation", input.sizes.validation),
    audit: take("audit", input.sizes.audit),
    production: take("production", input.sizes.production),
    heldOut: heldSorted.slice(0, input.sizes.heldOut).map((example) => ({
      role: "held-out",
      example,
    })),
  };
}

export function limitSplit<T extends { id: string }>(
  split: PublicSplit<T>,
  rows: number | undefined,
): PublicSplit<T> {
  if (rows === undefined) return split;
  if (!Number.isInteger(rows) || rows < 1)
    throw new Error("--rows must be a positive integer.");
  return {
    seed: split.seed,
    optimization: split.optimization.slice(0, rows),
    validation: split.validation.slice(0, rows),
    audit: split.audit.slice(0, rows),
    production: split.production.slice(0, rows),
    heldOut: split.heldOut.slice(0, rows),
  };
}

export function poolDatasetRow<T extends { id: string }>(
  row: PoolRow<T>,
  input: JsonValue,
  label: JsonValue,
): DatasetRow {
  if (row.role !== "pool")
    throw new Error("Held-out rows cannot enter the dataset.");
  if (row.partition === "production")
    throw new Error("Production rows are not a dataset partition.");
  const occurredAt = DATES[row.partition];
  return {
    id: row.example.id,
    episodeId: row.example.id,
    entityId: row.example.id,
    occurredAt,
    observedAt: occurredAt,
    source: TRUSTED_SOURCE,
    input,
    label,
  };
}

export function datasetSnapshot(
  version: string,
  rows: {
    optimization: DatasetRow[];
    validation: DatasetRow[];
    audit: DatasetRow[];
  },
): DatasetSnapshot {
  return { version, ...rows };
}

export function idsOf<T extends { id: string }>(
  rows: readonly { example: T }[],
): string[] {
  return rows.map((row) => row.example.id);
}
