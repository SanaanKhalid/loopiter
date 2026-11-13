/** Read the fetch-script cache. The held-out sample is frozen and disjoint from train. */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { mulberry32, shuffle } from "../kb-qa/stats.js";
import { repoRoot } from "../public/paths.js";
import type { HotpotExample, Paragraph } from "./fixtures.js";
import {
  HOTPOT_HELDOUT_ROWS,
  HOTPOT_HELDOUT_SEED,
  HOTPOT_PARAGRAPHS,
  HOTPOT_REVISION,
} from "./pins.js";

export async function loadHotpotCache(): Promise<{ pool: HotpotExample[]; heldOut: HotpotExample[] }> {
  const root = join(repoRoot(import.meta.url), "benchmarks", ".cache", "hotpotqa");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
    revision?: string;
  };
  if (manifest.revision !== HOTPOT_REVISION)
    throw new Error("HotpotQA cache revision does not match the pin. Run fetch.py again.");
  const train = keepFullParagraphRows(await readJsonl(join(root, "train.jsonl"))).rows;
  const validation = keepFullParagraphRows(await readJsonl(join(root, "validation.jsonl"))).rows;
  const trainIds = new Set(train.map((row) => row.id));
  for (const row of validation)
    if (trainIds.has(row.id))
      throw new Error(`Validation row ${row.id} collides with the train split.`);
  const frozen = shuffle(
    [...validation].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    mulberry32(HOTPOT_HELDOUT_SEED),
  ).slice(0, HOTPOT_HELDOUT_ROWS);
  if (frozen.length !== HOTPOT_HELDOUT_ROWS)
    throw new Error(`HotpotQA validation cache cannot fill ${HOTPOT_HELDOUT_ROWS} held-out rows.`);
  return { pool: train, heldOut: frozen };
}

async function readJsonl(path: string): Promise<unknown[]> {
  // Train jsonl is larger than V8's maximum string, so read line by line.
  const rows: unknown[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      rows.push(JSON.parse(line) as unknown);
    }
  } catch (error) {
    if (isMissingFile(error))
      throw new Error(`Missing ${path}. Run benchmarks/hotpotqa/fetch.py. CI does not download it.`);
    throw error;
  }
  return rows;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Drop rows that are not the frozen 10-paragraph distractor context. */
export function keepFullParagraphRows(values: unknown[]): { rows: HotpotExample[]; dropped: number } {
  const rows: HotpotExample[] = [];
  let dropped = 0;
  for (const value of values) {
    const row = parseRow(value);
    if (!row) {
      dropped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, dropped };
}

function parseRow(value: unknown): HotpotExample | null {
  if (!value || typeof value !== "object") throw new Error("HotpotQA cache row is not an object.");
  const row = value as Record<string, unknown>;
  const id = stringField(row, "id");
  const question = stringField(row, "question");
  const answer = stringField(row, "answer");
  if (!Array.isArray(row.paragraphs))
    throw new Error(`HotpotQA row ${id} does not have ${HOTPOT_PARAGRAPHS} frozen paragraphs.`);
  if (row.paragraphs.length !== HOTPOT_PARAGRAPHS) return null;
  const paragraphs = row.paragraphs.map(parseParagraph);
  return { id, question, answer, paragraphs, baselinePass: false };
}

function parseParagraph(value: unknown): Paragraph {
  if (!value || typeof value !== "object") throw new Error("HotpotQA paragraph is missing.");
  const row = value as Record<string, unknown>;
  return { title: stringField(row, "title"), text: stringField(row, "text") };
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`HotpotQA cache row is missing ${key}.`);
  return value;
}
