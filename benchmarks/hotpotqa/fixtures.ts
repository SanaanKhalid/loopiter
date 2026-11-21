/** Tiny synthetic distractor rows. They are not the HotpotQA release. */
import { FIXTURE_SIZES } from "../public/constants.js";
import { HOTPOT_PARAGRAPHS } from "./pins.js";

export interface Paragraph {
  title: string;
  text: string;
}

export interface HotpotExample {
  id: string;
  baselinePass: boolean;
  question: string;
  answer: string;
  paragraphs: Paragraph[];
  /** Titles of the gold supporting paragraphs. Absent caches fall back to answer overlap. */
  supportingTitles?: string[];
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

export function hotpotFixtures(): { pool: HotpotExample[]; heldOut: HotpotExample[] } {
  const pool = Array.from({ length: poolCount() }, (_, index) => {
    const id = `pool-${index}`;
    return row(id, "Paris", BASELINE_PASS_IDS.has(id));
  });
  const heldOut = Array.from({ length: FIXTURE_SIZES.heldOut }, (_, index) =>
    row(`held-${index}`, index % 2 === 0 ? "Paris" : "Lima", index % 6 === 0),
  );
  return { pool, heldOut };
}

export function row(id: string, answer: string, baselinePass: boolean): HotpotExample {
  const paragraphs = Array.from({ length: HOTPOT_PARAGRAPHS }, (_, index) => ({
    title: `Paragraph ${index + 1}`,
    text:
      index === 0
        ? `The city in the notes is ${answer}.`
        : `Distractor note ${index} for ${id}.`,
  }));
  return {
    id,
    baselinePass,
    question: `Which city does fixture ${id} name?`,
    answer,
    paragraphs,
    supportingTitles: [paragraphs[0]!.title],
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
