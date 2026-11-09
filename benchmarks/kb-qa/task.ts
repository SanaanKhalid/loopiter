/**
 * Synthetic internal knowledge-base QA task.
 *
 * The versioned artifact is a bounded prompt fragment: one line per passage.
 * Retrieval is frozen. It never reads the artifact. A hit returns the passage
 * the question names plus a distractor. Misses and out-of-scope questions do
 * not return a passage the fragment can use, so editing the KB cannot fix them.
 * Train rows are the controller's optimization partition. Dev rows are the
 * validation and audit partitions. The held-out test split is separate and
 * must not be placed in a dataset snapshot.
 */
import type { DatasetRow } from "../../src/index.js";
import { mulberry32, shuffle } from "./stats.js";

export const FACTS = [
  {
    id: "staff-pto",
    keyword: "staff vacation",
    gold: "18 days",
    stale: "10 days",
    correctAtBaseline: true,
  },
  {
    id: "contractor-pto",
    keyword: "contractor vacation",
    gold: "12 days",
    stale: "11 days",
    correctAtBaseline: false,
  },
  {
    id: "meal-expense",
    keyword: "meal allowance",
    gold: "40 usd",
    stale: "25 usd",
    correctAtBaseline: false,
  },
  {
    id: "travel-expense",
    keyword: "travel allowance",
    gold: "250 usd",
    stale: "250 usd",
    correctAtBaseline: true,
  },
  {
    id: "office-holiday",
    keyword: "office holiday",
    gold: "25 december",
    stale: "24 december",
    correctAtBaseline: false,
  },
  {
    id: "warehouse-holiday",
    keyword: "warehouse holiday",
    gold: "26 december",
    stale: "27 december",
    correctAtBaseline: false,
  },
  {
    id: "employee-badge",
    keyword: "employee badge",
    gold: "facilities desk",
    stale: "security email",
    correctAtBaseline: false,
  },
  {
    id: "visitor-badge",
    keyword: "visitor badge",
    gold: "reception desk",
    stale: "reception desk",
    correctAtBaseline: true,
  },
] as const;

export type FactId = (typeof FACTS)[number]["id"];

/** Wrong for every fact. Used only by the injected harmful candidate. */
export const HARMFUL_VALUE = "redacted";

/** Emitted when the mock slips into a partial or noisy answer. */
export const INCOMPLETE = "incomplete";

const NEAR_MISS = new Set<FactId>([
  "contractor-pto",
  "warehouse-holiday",
  "meal-expense",
]);

const DISTRACTOR: Record<FactId, FactId> = {
  "staff-pto": "contractor-pto",
  "contractor-pto": "staff-pto",
  "meal-expense": "travel-expense",
  "travel-expense": "meal-expense",
  "office-holiday": "warehouse-holiday",
  "warehouse-holiday": "office-holiday",
  "employee-badge": "visitor-badge",
  "visitor-badge": "employee-badge",
};

const HOPS: readonly { facts: readonly [FactId, FactId]; label: string }[] = [
  {
    facts: ["staff-pto", "meal-expense"],
    label: "18 days and 40 usd",
  },
  {
    facts: ["office-holiday", "employee-badge"],
    label: "25 december and facilities desk",
  },
];

/**
 * One block is every fact once, two multi-hop questions, two retrieval misses,
 * and two out-of-scope questions. The mix is the task, not a fitted rate.
 * Repeats make the audit sample large enough for the controller's paired
 * Hoeffding gate under this block.
 */
export const REPEATS = {
  train: 1,
  validation: 4,
  audit: 16,
  test: 4,
  production: 4,
} as const;

const TEMPLATES_PER_BLOCK = FACTS.length + HOPS.length + 4;

export const SPLIT_COUNTS = {
  train: REPEATS.train * TEMPLATES_PER_BLOCK,
  validation: REPEATS.validation * TEMPLATES_PER_BLOCK,
  audit: REPEATS.audit * TEMPLATES_PER_BLOCK,
  test: REPEATS.test * TEMPLATES_PER_BLOCK,
  production: REPEATS.production * TEMPLATES_PER_BLOCK,
} as const;

/**
 * Mock reliability is chosen per seed inside this band. It is not fit to a
 * held-out score. Lower values slip more often.
 */
export const RELIABILITY = { minimum: 0.68, span: 0.18 } as const;

/**
 * Candidate accuracy floor. In-scope rows are 10 of 14, and the mock is
 * reliable only inside RELIABILITY. The floor is under that product and
 * above a fragment that never matches a label.
 */
export const ACCURACY_FLOOR = 0.15;

/**
 * Observation rolls back a collapsed deployment. Honest traffic still misses
 * the unfixable rows, so the ceiling is not a near-zero error rate.
 */
export const OBSERVATION_ERROR_CEILING = 0.85;

const TRUSTED_SOURCE = "verified-export";

export type QuestionKind =
  | "single"
  | "near-miss"
  | "multi-hop"
  | "miss"
  | "out-of-scope";

export interface Retrieval {
  mode: "hit" | "miss" | "out-of-scope";
  kind: QuestionKind;
  required: FactId[];
  passages: FactId[];
}

export interface TaskSplit {
  seed: number;
  optimization: DatasetRow[];
  validation: DatasetRow[];
  audit: DatasetRow[];
  test: DatasetRow[];
  production: { id: string; question: string; label: string }[];
}

export function mockReliability(seed: number): number {
  const draw = mulberry32(seed ^ 0x5eed)();
  return RELIABILITY.minimum + draw * RELIABILITY.span;
}

export function labels(): string[] {
  const values = new Set<string>([HARMFUL_VALUE, INCOMPLETE, "out of scope"]);
  for (const fact of FACTS) {
    values.add(fact.gold);
    values.add(fact.stale);
  }
  for (const hop of HOPS) {
    const left = valueChoices(hop.facts[0]);
    const right = valueChoices(hop.facts[1]);
    for (const a of left)
      for (const b of right) values.add(`${a} and ${b}`);
  }
  return [...values].sort();
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

/** Frozen retrieval. The artifact is not an argument. */
export function retrieve(question: string): Retrieval {
  const matched = FACTS.filter((fact) => question.includes(fact.keyword));
  if (matched.length > 2)
    throw new Error("Question matches more than two passages.");
  if (matched.length === 2) {
    const required = matched.map((fact) => fact.id);
    return {
      mode: "hit",
      kind: "multi-hop",
      required,
      passages: uniquePassages([...required, DISTRACTOR[required[0]!]]),
    };
  }
  if (matched.length === 1) {
    const id = matched[0]!.id;
    return {
      mode: "hit",
      kind: NEAR_MISS.has(id) ? "near-miss" : "single",
      required: [id],
      passages: [id, DISTRACTOR[id]],
    };
  }
  if (question.includes("home address"))
    return {
      mode: "out-of-scope",
      kind: "out-of-scope",
      required: [],
      passages: ["staff-pto"],
    };
  if (question.includes("share price"))
    return {
      mode: "out-of-scope",
      kind: "out-of-scope",
      required: [],
      passages: ["office-holiday"],
    };
  if (question.includes("per diem"))
    return {
      mode: "miss",
      kind: "miss",
      required: [],
      passages: ["visitor-badge"],
    };
  if (question.includes("access token"))
    return {
      mode: "miss",
      kind: "miss",
      required: [],
      passages: ["travel-expense"],
    };
  throw new Error("Question is outside the frozen retrieval rules.");
}

/**
 * Mock answer. The slip decision depends on the seed and the question, so
 * baseline and candidate see the same noise on a row, and a different seed
 * does not. A slip reads a distractor or returns a partial answer. Misses
 * and out-of-scope questions ignore the required facts.
 */
export function answer(fragment: string, question: string, seed: number): string {
  const knowledge = parseKnowledge(fragment);
  const hit = retrieve(question);
  const draw = unitDraw(seed, question);
  const reliability = mockReliability(seed);
  const distractor = hit.passages.find((id) => !hit.required.includes(id)) ?? hit.passages[0];
  if (!distractor) throw new Error("Retrieval returned no passage.");
  if (hit.mode !== "hit") return knowledge[distractor];
  if (draw >= reliability) {
    if (hit.kind === "multi-hop") return knowledge[hit.required[0]!];
    const slipSpan = 1 - reliability;
    if (draw >= reliability + slipSpan / 2) return INCOMPLETE;
    return knowledge[distractor];
  }
  if (hit.kind === "multi-hop")
    return `${knowledge[hit.required[0]!]!} and ${knowledge[hit.required[1]!]!}`;
  return knowledge[hit.required[0]!]!;
}

export function improveFragment(
  fragment: string,
  train: readonly { question: string; label: string }[],
): string {
  const knowledge = parseKnowledge(fragment);
  for (const row of train) {
    const hit = retrieve(row.question);
    if (hit.mode !== "hit") continue;
    if (hit.required.length === 2) {
      const parts = row.label.split(" and ");
      if (parts.length !== 2) throw new Error("Multi-hop train label is not a pair.");
      knowledge[hit.required[0]!] = parts[0]!;
      knowledge[hit.required[1]!] = parts[1]!;
      continue;
    }
    knowledge[hit.required[0]!] = row.label;
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
  seed: number,
): { successes: number; trials: number; rate: number } {
  let successes = 0;
  for (const row of rows)
    successes += Number(answer(fragment, row.question, seed) === row.label);
  const trials = rows.length;
  return { successes, trials, rate: trials === 0 ? 0 : successes / trials };
}

export function buildSplit(seed: number): TaskSplit {
  if (!Number.isInteger(seed)) throw new Error("Task seed must be an integer.");
  const rng = mulberry32(seed);
  const optimization = shuffle(block("optimization", REPEATS.train, seed), rng).map((item) =>
    datasetRow(item, "optimization"),
  );
  const validation = shuffle(block("validation", REPEATS.validation, seed), rng).map((item) =>
    datasetRow(item, "validation"),
  );
  const audit = shuffle(block("audit", REPEATS.audit, seed), rng).map((item) =>
    datasetRow(item, "audit"),
  );
  const test = shuffle(block("test", REPEATS.test, seed), rng).map((item) =>
    datasetRow(item, "test"),
  );
  const production = block("production", REPEATS.production, seed).map((item) => ({
    id: item.id,
    question: item.question,
    label: item.label,
  }));
  return { seed, optimization, validation, audit, test, production };
}

export function questionText(row: DatasetRow): string {
  const text = (row.input as { text?: unknown }).text;
  if (typeof text !== "string" || typeof row.label !== "string")
    throw new Error("Benchmark row is missing text or label.");
  return text;
}

function block(
  partition: string,
  copies: number,
  seed: number,
): { id: string; question: string; label: string }[] {
  const rows: { id: string; question: string; label: string }[] = [];
  for (let copy = 0; copy < copies; copy++) {
    let slot = 0;
    const push = (question: string, label: string) => {
      const id = `s${seed}-${partition}-c${copy}-q${slot}`;
      rows.push({ id, question, label });
      slot += 1;
    };
    for (const fact of FACTS)
      push(
        `Handbook ${partition} ${copy}.${slot}: what is the ${fact.keyword} rule?`,
        fact.gold,
      );
    for (const hop of HOPS)
      push(
        `Handbook ${partition} ${copy}.${slot}: combine ${factKeyword(hop.facts[0])} and ${factKeyword(hop.facts[1])}.`,
        hop.label,
      );
    push(
      `Handbook ${partition} ${copy}.${slot}: what is the per diem food cap?`,
      "40 usd",
    );
    push(
      `Handbook ${partition} ${copy}.${slot}: where is an access token collected?`,
      "facilities desk",
    );
    push(
      `Handbook ${partition} ${copy}.${slot}: what is the chief executive home address?`,
      "out of scope",
    );
    push(
      `Handbook ${partition} ${copy}.${slot}: what was yesterday share price?`,
      "out of scope",
    );
    if (slot !== TEMPLATES_PER_BLOCK) throw new Error("Block size drifted.");
  }
  return rows;
}

function datasetRow(
  item: { id: string; question: string; label: string },
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
  return {
    id: item.id,
    episodeId: item.id,
    entityId: item.id,
    occurredAt,
    observedAt: occurredAt.replace("T12:", "T14:"),
    source: TRUSTED_SOURCE,
    input: { text: item.question },
    label: item.label,
  };
}

function factKeyword(id: FactId): string {
  const fact = FACTS.find((item) => item.id === id);
  if (!fact) throw new Error(`Unknown fact ${id}.`);
  return fact.keyword;
}

function valueChoices(id: FactId): string[] {
  const fact = FACTS.find((item) => item.id === id);
  if (!fact) throw new Error(`Unknown fact ${id}.`);
  return [fact.gold, fact.stale, HARMFUL_VALUE];
}

function uniquePassages(ids: FactId[]): FactId[] {
  const seen = new Set<FactId>();
  const passages: FactId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    passages.push(id);
  }
  return passages;
}

function unitDraw(seed: number, question: string): number {
  let hash = 2166136261;
  const text = `${seed}\n${question}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return mulberry32(hash)();
}
