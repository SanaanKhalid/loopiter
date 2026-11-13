/**
 * Propose calls send a bounded sample of rows. Failures come first.
 * The rest are a seeded shuffle, and the JSON payload stays inside a byte budget.
 */
import { mulberry32, shuffle } from "../kb-qa/stats.js";

export const PROPOSE_BYTE_BUDGET = 16_384;
export const PROPOSE_EXAMPLE_CAP = 8;
export const PROPOSE_SELECTION_SEED = 1402;

export function proposeLimits(env: NodeJS.ProcessEnv = process.env): {
  byteBudget: number;
  exampleCap: number;
} {
  return {
    byteBudget: positiveEnv(env.LOOPITER_BENCH_PROPOSE_BYTES, PROPOSE_BYTE_BUDGET),
    exampleCap: positiveEnv(env.LOOPITER_BENCH_PROPOSE_EXAMPLES, PROPOSE_EXAMPLE_CAP),
  };
}

export function selectProposeExamples<T>(input: {
  rows: readonly T[];
  failed: (row: T, index: number) => boolean;
  project: (row: T, index: number) => unknown;
  envelope: (examples: unknown[]) => string;
  seed?: number;
  byteBudget?: number;
  exampleCap?: number;
}): unknown[] {
  const limits = proposeLimits();
  const byteBudget = input.byteBudget ?? limits.byteBudget;
  const exampleCap = input.exampleCap ?? limits.exampleCap;
  const indexed = input.rows.map((row, index) => ({ row, index }));
  const failed = indexed.filter((item) => input.failed(item.row, item.index));
  const rest = shuffle(
    indexed.filter((item) => !input.failed(item.row, item.index)),
    mulberry32(input.seed ?? PROPOSE_SELECTION_SEED),
  );
  const chosen: unknown[] = [];
  for (const item of [...failed, ...rest]) {
    if (chosen.length >= exampleCap) break;
    const next = input.project(item.row, item.index);
    const encoded = input.envelope([...chosen, next]);
    if (Buffer.byteLength(encoded, "utf8") > byteBudget) continue;
    chosen.push(next);
  }
  return chosen;
}

function positiveEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}
