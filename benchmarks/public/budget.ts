/**
 * Controller token ceilings. The per-call number is `reservedModelTokens`,
 * the same reservation LiveSession.generate passes to `meter`.
 */
import { reservedModelTokens } from "../kb-qa/live.js";
import { requestBody } from "./bodies.js";
import { PREDICT_NAME, PROPOSE_INSTRUCTIONS, PROPOSE_NAME } from "./instructions.js";
import type { BenchmarkTask, PublicExample } from "./task.js";

export function sizedReservations<T extends PublicExample>(input: {
  task: BenchmarkTask<T>;
  prompt: string;
  predictRow: T;
  proposeRows: readonly T[];
  predictMaxOutputTokens: number;
  proposeMaxOutputTokens: number;
  deployment?: string;
}): { predict: number; propose: number } {
  const model = input.deployment ?? "gpt-5.4-mini";
  const predictBody = requestBody({
    model,
    instructions: input.prompt,
    payload: input.task.predictPayload(input.predictRow),
    name: PREDICT_NAME,
    schema: input.task.predictSchema(),
    maxOutputTokens: input.predictMaxOutputTokens,
    reasoningEffort: null,
  });
  const proposeBody = requestBody({
    model,
    instructions: PROPOSE_INSTRUCTIONS,
    payload: input.task.proposePayload(
      input.prompt,
      input.proposeRows,
      input.proposeRows.map(() => []),
    ),
    name: PROPOSE_NAME,
    schema: input.task.proposeSchema(),
    maxOutputTokens: input.proposeMaxOutputTokens,
    reasoningEffort: null,
  });
  return {
    predict: reservedModelTokens(predictBody, input.predictMaxOutputTokens),
    propose: reservedModelTokens(proposeBody, input.proposeMaxOutputTokens),
  };
}

export function longestExample<T extends PublicExample>(
  task: BenchmarkTask<T>,
  rows: readonly T[],
): T {
  const first = rows[0];
  if (!first) throw new Error("Cannot size a budget without a row.");
  return rows.reduce((best, row) =>
    task.predictPayload(row).length > task.predictPayload(best).length ? row : best,
  );
}
