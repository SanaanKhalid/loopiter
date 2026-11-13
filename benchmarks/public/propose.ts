import {
  FOLLOW_MARKER,
  HARM_MARKER,
  appendMarker,
} from "./constants.js";
import type { InstructionMark, ProposeRequest, PublicExample } from "./task.js";

/** Mock rewrite. The live model replaces this. Feedback is per instruction. */
export function mockRewrite<T extends PublicExample>(
  input: ProposeRequest<T>,
  cap: number,
  feedbackPredicts: boolean,
): string {
  if (input.mode === "harmful") return appendMarker(input.current, HARM_MARKER, cap);
  if (feedbackPredicts) {
    const failed = input.feedback.some((row) => row.some((mark) => !mark.strict));
    if (!failed) return input.current;
    return appendMarker(input.current, FOLLOW_MARKER, cap);
  }
  if (input.current.includes(FOLLOW_MARKER) || input.current.includes(HARM_MARKER))
    return input.current;
  return appendMarker(input.current, FOLLOW_MARKER, cap);
}

export function marksFrom(feedback: InstructionMark[][]): InstructionMark[][] {
  return feedback.map((row) => row.map((mark) => ({ ...mark })));
}

/** Deterministic mock completion. Markers override the row's baseline bit. */
export function scriptedAnswer(
  prompt: string,
  baselinePass: boolean,
  passText: string,
  failText: string,
): string {
  if (prompt.includes(HARM_MARKER)) return failText;
  if (prompt.includes(FOLLOW_MARKER)) return passText;
  return baselinePass ? passText : failText;
}
