import { FIXTURE_SIZES, FULL_SIZES, PROMPT_CAP, SMOKE_ROWS } from "../public/constants.js";
import { fragmentSchema, textSchema } from "../public/instructions.js";
import { scriptedAnswer } from "../public/propose.js";
import type { JsonValue } from "../../src/index.js";
import type { BenchmarkTask, RowScore } from "../public/task.js";
import { loadHotpotCache } from "./cache.js";
import { hotpotFixtures, type HotpotExample } from "./fixtures.js";
import { exactMatch, tokenF1 } from "./normalize.js";
import { HOTPOT_PROMPT_VERSION, HOTPOT_SYSTEM_PROMPT } from "./prompt.js";

const FAIL_TEXT = "unknown";

export const hotpotTask: BenchmarkTask<HotpotExample> = {
  id: "hotpotqa",
  title: "HotpotQA",
  liveDir: "reports/hotpotqa-live",
  promptCap: PROMPT_CAP,
  promptVersion: HOTPOT_PROMPT_VERSION,
  baselinePrompt: HOTPOT_SYSTEM_PROMPT,
  fullSizes: FULL_SIZES,
  smokeRows: SMOKE_ROWS,
  feedbackPredicts: false,
  predict: { min: 1, max: 2048, defaultValue: 256 },
  propose: { min: 1, max: 4096, defaultValue: 2048 },
  fixtureSizes: FIXTURE_SIZES,
  fixtures: hotpotFixtures,
  loadCache: loadHotpotCache,
  userText: (row) => row.question,
  datasetInput: (row) =>
    JSON.parse(
      JSON.stringify({
        text: row.question,
        paragraphs: row.paragraphs,
      }),
    ) as JsonValue,
  datasetLabel: (row) => row.answer,
  mockAnswer: (prompt, row) => scriptedAnswer(prompt, row.baselinePass, row.answer, FAIL_TEXT),
  scoreMany: async (items) => items.map((item) => scoreOne(item.response, item.row.answer)),
  predictPayload: (row) =>
    JSON.stringify({
      question: row.question,
      paragraphs: row.paragraphs,
    }),
  proposePayload: (current, rows) =>
    JSON.stringify({
      fragment: current,
      examples: rows.map((row) => ({
        question: row.question,
        paragraphs: row.paragraphs,
        answer: row.answer,
      })),
    }),
  predictSchema: textSchema,
  proposeSchema: () => fragmentSchema(PROMPT_CAP),
  emptyScore: () => ({
    primary: 0,
    loose: null,
    f1: 0,
    instructionStrictPasses: 0,
    instructionStrictTotal: 0,
    instructionLoosePasses: 0,
    instructionLooseTotal: 0,
    instructions: [],
  }),
};

function scoreOne(response: string, answer: string): RowScore {
  const matched = exactMatch(response, answer);
  return {
    primary: matched ? 1 : 0,
    loose: null,
    f1: tokenF1(response, answer),
    instructionStrictPasses: 0,
    instructionStrictTotal: 0,
    instructionLoosePasses: 0,
    instructionLooseTotal: 0,
    instructions: [],
  };
}
