import { FIXTURE_SIZES, FULL_SIZES, PROMPT_CAP, SMOKE_ROWS } from "../public/constants.js";
import { fragmentSchema, textSchema } from "../public/instructions.js";
import { scriptedAnswer } from "../public/propose.js";
import type { JsonValue } from "../../src/index.js";
import type { BenchmarkTask, InstructionMark, RowScore } from "../public/task.js";
import { loadIfbenchCache } from "./cache.js";
import { ifbenchFixtures, type IfExample } from "./fixtures.js";
import { IFBENCH_PROMPT_VERSION, IFBENCH_SYSTEM_PROMPT } from "./prompt.js";
import { selectProposeExamples } from "../public/propose-bound.js";
import { scoreWithVerifiers } from "./score.js";

const FAIL_TEXT = "plain reply";

export const ifbenchTask: BenchmarkTask<IfExample> = {
  id: "ifbench",
  title: "IFBench",
  liveDir: "reports/ifbench-live",
  promptCap: PROMPT_CAP,
  promptVersion: IFBENCH_PROMPT_VERSION,
  baselinePrompt: IFBENCH_SYSTEM_PROMPT,
  fullSizes: FULL_SIZES,
  smokeRows: SMOKE_ROWS,
  feedbackPredicts: true,
  predict: { min: 1024, max: 2048, defaultValue: 2048 },
  propose: { min: 1, max: 4096, defaultValue: 2048 },
  fixtureSizes: FIXTURE_SIZES,
  fixtures: ifbenchFixtures,
  loadCache: loadIfbenchCache,
  userText: (row) => row.prompt,
  datasetInput: (row) => ({ text: row.prompt }),
  datasetLabel: (row) =>
    JSON.parse(
      JSON.stringify({
        instructionIdList: row.instructionIdList,
        kwargs: row.kwargs,
      }),
    ) as JsonValue,
  mockAnswer: (prompt, row) => scriptedAnswer(prompt, row.baselinePass, passText(row), FAIL_TEXT),
  scoreMany: async (items) => scoreItems(items),
  predictPayload: (row) => JSON.stringify({ task: row.prompt }),
  proposePayload: (current, rows, feedback) => {
    const examples = selectProposeExamples({
      rows,
      failed: (_row, index) => failedFeedback(feedback[index] ?? []),
      project: (row, index) => ({
        prompt: row.prompt,
        instructions: row.instructionIdList,
        feedback: (feedback[index] ?? []).map(mark),
        score: feedbackScore(feedback[index] ?? []),
      }),
      envelope: (chosen) => JSON.stringify({ fragment: current, examples: chosen }),
    });
    return JSON.stringify({ fragment: current, examples });
  },
  predictSchema: textSchema,
  proposeSchema: () => fragmentSchema(PROMPT_CAP),
  emptyScore: () => emptyIfScore(),
};

async function scoreItems(
  items: { response: string; row: IfExample }[],
): Promise<RowScore[]> {
  return scoreWithVerifiers(
    items.map((item) => ({
      prompt: item.row.prompt,
      response: item.response,
      instructionIdList: item.row.instructionIdList,
      kwargs: item.row.kwargs,
    })),
  );
}

function passText(row: IfExample): string {
  const words = row.kwargs.flatMap((kwargs) => {
    const keywords = kwargs.keywords;
    return Array.isArray(keywords) ? keywords.filter((word) => typeof word === "string") : [];
  });
  return `${words.join(" ")} done`;
}

function mark(item: InstructionMark): { id: string; passed: boolean } {
  return { id: item.id, passed: item.strict };
}

function failedFeedback(marks: InstructionMark[]): boolean {
  return marks.some((item) => !item.strict);
}

function feedbackScore(marks: InstructionMark[]): number | null {
  if (marks.length === 0) return null;
  const passed = marks.filter((item) => item.strict).length;
  return passed / marks.length;
}

function emptyIfScore(): RowScore {
  return {
    primary: 0,
    loose: 0,
    f1: null,
    instructionStrictPasses: 0,
    instructionStrictTotal: 0,
    instructionLoosePasses: 0,
    instructionLooseTotal: 0,
    instructions: [],
  };
}
