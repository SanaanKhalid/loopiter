/**
 * Eval-split locks for the public benchmarks.
 * Fixture locks are committed. A pinned lock is checked only when that file
 * is present, because the full pinned rows are not stored in the repository.
 * A mismatch stops the run before any model call.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyEvalLock, type EvalSuite } from "../../src/eval-lock.js";
import { repoRoot } from "./paths.js";
import type { BenchmarkTask, PublicExample } from "./task.js";

export function suiteFromTask<T extends PublicExample>(
  task: BenchmarkTask<T>,
  rows: readonly T[],
): EvalSuite {
  return {
    items: rows.map((row) => ({
      id: row.id,
      input: task.datasetInput(row),
      expected: task.datasetLabel(row),
    })),
  };
}

export function fixtureEvalLockPath(taskId: string): string {
  return join(repoRoot(import.meta.url), "benchmarks", taskId, "fixtures.eval.lock.json");
}

export function pinnedEvalLockPath(taskId: string): string {
  return join(repoRoot(import.meta.url), "benchmarks", taskId, "pinned-eval.lock.json");
}

/** Refuse a changed eval split. A missing lock is ignored only when `optional` is set. */
export function guardEvalSuite(suite: EvalSuite, lockPath: string, optional = false): void {
  if (optional && !existsSync(lockPath)) return;
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch {
    throw new Error("Missing eval lock.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Eval lock is unreadable.");
  }
  let report;
  try {
    report = verifyEvalLock(suite, parsed);
  } catch {
    throw new Error("Eval lock is unreadable.");
  }
  if (!report.ok)
    throw new Error(
      `Eval lock drift added ${report.added} removed ${report.removed} changed ${report.changed}.`,
    );
}
