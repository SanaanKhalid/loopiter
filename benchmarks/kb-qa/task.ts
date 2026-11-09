/**
 * Synthetic internal knowledge-base QA task.
 *
 * The versioned artifact is a bounded prompt fragment: one line per passage.
 * Retrieval selects a passage id from the question alone and is frozen for
 * both arms. Only the passage text inside the artifact can change.
 * Train rows are the controller's optimization partition. Dev rows are the
 * validation and audit partitions (both are improvement-time gates). The
 * held-out test split is returned separately and must not be placed in a
 * dataset snapshot.
 */
import type { DatasetRow } from "../../src/index.js";
import { mulberry32, shuffle } from "./stats.js";

export const FACTS = [
  {
    id: "pto",
    keyword: "vacation",
    gold: "18 days",
    stale: "10 days",
    correctAtBaseline: true,
  },
  {
    id: "vpn",
    keyword: "vpn",
    gold: "portal reset",
    stale: "extension 100",
    correctAtBaseline: true,
  },
  {
    id: "expense",
    keyword: "expense",
    gold: "250 usd",
    stale: "50 usd",
    correctAtBaseline: false,
  },
  {
    id: "holiday",
    keyword: "holiday",
    gold: "25 december",
    stale: "24 december",
    correctAtBaseline: false,
  },
  {
    id: "badge",
    keyword: "badge",
    gold: "facilities desk",
    stale: "security email",
    correctAtBaseline: false,
  },
] as const;

export type FactId = (typeof FACTS)[number]["id"];

/** A value that is in the label set and wrong for every fact, including baseline-correct ones. */
export const HARMFUL_VALUE = "10 days";

export const SPLIT_COUNTS = {
  train: 2,
  validation: 4,
  audit: 6,
  test: 4,
} as const;

const QUESTIONS_PER_FACT =
  SPLIT_COUNTS.train +
  SPLIT_COUNTS.validation +
  SPLIT_COUNTS.audit +
  SPLIT_COUNTS.test;

const TRUSTED_SOURCE = "verified-export";

export interface TaskSplit {
  seed: number;
  optimization: DatasetRow[];
  validation: DatasetRow[];
  audit: DatasetRow[];
  test: DatasetRow[];
  production: { id: string; question: string; label: string }[];
}

export function labels(): string[] {
  return [...new Set(FACTS.flatMap((fact) => [fact.gold, fact.stale]))].sort();
}

export function baselineKnowledge(): Record<FactId, string> {
  const knowledge = {} as Record<FactId, string>;
  for (const fact of FACTS)
    knowledge[fact.id] = fact.correctAtBaseline ? fact.gold : fact.stale;
  return knowledge;
}

export function serializeKnowledge(knowledge: Record<FactId, string>): string {
  return FACTS.map((fact) => {
    const value = knowledge[fact.id];
    if (typeof value !== "string" || value.includes("\n") || value.includes("="))
      throw new Error(`Invalid passage text for ${fact.id}.`);
    return `${fact.id}=${value}`;
  }).join("\n");
}

export function parseKnowledge(fragment: string): Record<FactId, string> {
  const knowledge = {} as Record<FactId, string>;
  for (const line of fragment.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("KB fragment line is missing an id.");
    const id = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!FACTS.some((fact) => fact.id === id))
      throw new Error(`Unknown passage ${id}.`);
    knowledge[id as FactId] = value;
  }
  for (const fact of FACTS)
    if (typeof knowledge[fact.id] !== "string")
      throw new Error(`KB fragment is missing ${fact.id}.`);
  return knowledge;
}

export function baselineFragment(): string {
  return serializeKnowledge(baselineKnowledge());
}

/** Frozen retrieval: passage id depends only on the question text. */
export function retrieve(question: string): FactId {
  const found = FACTS.filter((fact) => question.includes(fact.keyword));
  if (found.length !== 1)
    throw new Error("Question must select exactly one frozen passage.");
  return found[0]!.id;
}

/** Read the retrieved passage from the versioned artifact and return its text. */
export function answer(fragment: string, question: string): string {
  const knowledge = parseKnowledge(fragment);
  return knowledge[retrieve(question)];
}

export function improveFragment(
  fragment: string,
  train: readonly { question: string; label: string }[],
): string {
  const knowledge = parseKnowledge(fragment);
  for (const row of train) {
    if (typeof row.label !== "string") throw new Error("Train label missing.");
    knowledge[retrieve(row.question)] = row.label;
  }
  return serializeKnowledge(knowledge);
}

export function harmfulFragment(): string {
  const knowledge = {} as Record<FactId, string>;
  for (const fact of FACTS) knowledge[fact.id] = HARMFUL_VALUE;
  return serializeKnowledge(knowledge);
}

export function successCount(
  fragment: string,
  rows: readonly { question: string; label: string }[],
): { successes: number; trials: number; rate: number } {
  let successes = 0;
  for (const row of rows) successes += Number(answer(fragment, row.question) === row.label);
  const trials = rows.length;
  return { successes, trials, rate: trials === 0 ? 0 : successes / trials };
}

export function buildSplit(seed: number): TaskSplit {
  if (!Number.isInteger(seed)) throw new Error("Task seed must be an integer.");
  const rng = mulberry32(seed);
  const optimization: DatasetRow[] = [];
  const validation: DatasetRow[] = [];
  const audit: DatasetRow[] = [];
  const test: DatasetRow[] = [];
  for (const fact of FACTS) {
    const questions = Array.from({ length: QUESTIONS_PER_FACT }, (_, index) =>
      questionFor(fact.id, fact.keyword, index),
    );
    const ordered = shuffle(questions, rng);
    const take = (count: number, cursor: { at: number }) => {
      const slice = ordered.slice(cursor.at, cursor.at + count);
      cursor.at += count;
      if (slice.length !== count) throw new Error("Split underrun.");
      return slice;
    };
    const cursor = { at: 0 };
    for (const question of take(SPLIT_COUNTS.train, cursor))
      optimization.push(row(seed, fact, question, "optimization"));
    for (const question of take(SPLIT_COUNTS.validation, cursor))
      validation.push(row(seed, fact, question, "validation"));
    for (const question of take(SPLIT_COUNTS.audit, cursor))
      audit.push(row(seed, fact, question, "audit"));
    for (const question of take(SPLIT_COUNTS.test, cursor))
      test.push(row(seed, fact, question, "test"));
    if (cursor.at !== QUESTIONS_PER_FACT) throw new Error("Split did not consume every question.");
  }
  const production = FACTS.flatMap((fact) =>
    [0, 1].map((index) => ({
      id: `prod-${seed}-${fact.id}-${index}`,
      question: `Production check ${index} for ${fact.keyword} after release.`,
      label: fact.gold,
    })),
  );
  return { seed, optimization, validation, audit, test, production };
}

export function questionText(row: DatasetRow): string {
  const text = (row.input as { text?: unknown }).text;
  if (typeof text !== "string" || typeof row.label !== "string")
    throw new Error("Benchmark row is missing text or label.");
  return text;
}

function questionFor(id: FactId, keyword: string, index: number): string {
  return `Internal handbook question ${index} about ${keyword} (${id}).`;
}

function row(
  seed: number,
  fact: (typeof FACTS)[number],
  question: string,
  partition: "optimization" | "validation" | "audit" | "test",
): DatasetRow {
  const occurredAt =
    partition === "optimization"
      ? "2026-01-15T12:00:00.000Z"
      : partition === "validation"
        ? "2026-02-15T12:00:00.000Z"
        : partition === "audit"
          ? "2026-03-15T12:00:00.000Z"
          : "2026-05-15T12:00:00.000Z";
  const id = `s${seed}-${partition}-${fact.id}-${question}`;
  return {
    id,
    episodeId: id,
    entityId: id,
    occurredAt,
    observedAt: occurredAt.replace("T12:", "T14:"),
    source: TRUSTED_SOURCE,
    input: { text: question },
    label: fact.gold,
  };
}
