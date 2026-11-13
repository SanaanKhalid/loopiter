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

export function hotpotFixtures(): { pool: HotpotExample[]; heldOut: HotpotExample[] } {
  const pool = Array.from({ length: poolCount() }, (_, index) =>
    row(`pool-${index}`, "Paris", false),
  );
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
