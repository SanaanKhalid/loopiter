/** Tiny synthetic rows for tests. They are not the official IFBench release. */
import { FIXTURE_SIZES } from "../public/constants.js";

export interface IfExample {
  id: string;
  baselinePass: boolean;
  prompt: string;
  instructionIdList: string[];
  kwargs: Record<string, unknown>[];
}

export function ifbenchFixtures(): { pool: IfExample[]; heldOut: IfExample[] } {
  const pool = Array.from({ length: poolCount() }, (_, index) =>
    row(`pool-${index}`, false),
  );
  const heldOut = Array.from({ length: FIXTURE_SIZES.heldOut }, (_, index) =>
    row(`held-${index}`, index % 6 === 0),
  );
  return { pool, heldOut };
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
