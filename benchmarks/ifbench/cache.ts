/** Read the fetch-script cache. Tests use fixtures and do not call this. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../public/paths.js";
import type { IfExample } from "./fixtures.js";
import {
  IFBENCH_TEST_REVISION,
  IFBENCH_TEST_ROWS,
  IFBENCH_TRAIN_REVISION,
} from "./pins.js";

export async function loadIfbenchCache(): Promise<{ pool: IfExample[]; heldOut: IfExample[] }> {
  const root = cacheDir();
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
    testRevision?: string;
    trainRevision?: string;
  };
  if (
    manifest.testRevision !== IFBENCH_TEST_REVISION ||
    manifest.trainRevision !== IFBENCH_TRAIN_REVISION
  )
    throw new Error("IFBench cache revisions do not match the pinned dataset SHAs. Run fetch.py again.");
  const heldOut = (await readJsonl(join(root, "test.jsonl"))).map(parseTest);
  const pool = (await readJsonl(join(root, "train.jsonl"))).map(parseTest);
  if (heldOut.length !== IFBENCH_TEST_ROWS)
    throw new Error(`IFBench test cache has ${heldOut.length} rows; the pin expects ${IFBENCH_TEST_ROWS}.`);
  const heldIds = new Set(heldOut.map((row) => row.id));
  const seen = new Set<string>();
  for (const row of pool) {
    if (seen.has(row.id)) throw new Error(`IFBench train id ${row.id} is duplicated.`);
    seen.add(row.id);
    if (heldIds.has(row.id))
      throw new Error(`Train row ${row.id} collides with the held-out test set.`);
  }
  return { pool, heldOut };
}

export function cacheDir(): string {
  return join(repoRoot(import.meta.url), "benchmarks", ".cache", "ifbench");
}

async function readJsonl(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Missing ${path}. Run benchmarks/ifbench/fetch.py. CI does not download it.`);
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function parseTest(value: unknown): IfExample {
  if (!value || typeof value !== "object") throw new Error("IFBench cache row is not an object.");
  const row = value as Record<string, unknown>;
  const id = stringField(row, "id");
  const prompt = stringField(row, "prompt");
  const instructionIdList = stringList(row.instructionIdList);
  const kwargs = Array.isArray(row.kwargs) ? row.kwargs.map(objectField) : [];
  if (kwargs.length !== instructionIdList.length)
    throw new Error(`IFBench row ${id} has mismatched instructions and kwargs.`);
  return {
    id,
    prompt,
    instructionIdList,
    kwargs,
    baselinePass: stablePass(id),
  };
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error(`IFBench cache row is missing ${key}.`);
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("IFBench instruction ids are missing.");
  return value as string[];
}

function objectField(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stablePass(id: string): boolean {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 4 === 0;
}
