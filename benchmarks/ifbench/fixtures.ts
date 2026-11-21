/** Tiny synthetic rows for tests. They are not the official IFBench release. */
import type { JsonValue } from "../../src/index.js";
import { FIXTURE_SIZES } from "../public/constants.js";

export interface IfExample {
  id: string;
  baselinePass: boolean;
  prompt: string;
  instructionIdList: string[];
  kwargs: Record<string, unknown>[];
}

/**
 * Seed 1 of the fixture sizes puts these ids in validation, or one in each
 * audit half. Baseline passes here give a harmful rewrite at least five
 * decisive losses, and leave at least five decisive wins for an improved
 * rewrite on validation and on each audit half.
 */
const BASELINE_PASS_IDS = new Set([
  "pool-3",
  "pool-5",
  "pool-9",
  "pool-16",
  "pool-30",
  "pool-10",
  "pool-23",
]);

export function ifbenchFixtures(): { pool: IfExample[]; heldOut: IfExample[] } {
  const pool = Array.from({ length: poolCount() }, (_, index) => {
    const id = `pool-${index}`;
    return row(id, BASELINE_PASS_IDS.has(id));
  });
  const heldOut = Array.from({ length: FIXTURE_SIZES.heldOut }, (_, index) =>
    row(`held-${index}`, index % 6 === 0),
  );
  return { pool, heldOut };
}

export function ifbenchDatasetInput(row: IfExample): JsonValue {
  return { text: row.prompt };
}

export function ifbenchDatasetLabel(row: IfExample): JsonValue {
  return JSON.parse(
    JSON.stringify({
      instructionIdList: row.instructionIdList,
      kwargs: row.kwargs,
    }),
  ) as JsonValue;
}

export function keywordFixture(response: string, keywords: string[]): IfExample & { response: string } {
  return {
    ...row("bridge-fixture", false),
    instructionIdList: ["keywords:existence"],
    kwargs: [{ keywords }],
    response,
  };
}

function row(id: string, baselinePass: boolean): IfExample {
  return {
    id,
    baselinePass,
    prompt: `Fixture ${id}. Include every required keyword.`,
    instructionIdList: ["keywords:existence"],
    kwargs: [{ keywords: ["quartz"] }],
  };
}

function poolCount(): number {
  return (
    FIXTURE_SIZES.optimization +
    FIXTURE_SIZES.validation +
    FIXTURE_SIZES.audit +
    FIXTURE_SIZES.production
  );
}
