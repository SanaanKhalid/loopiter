import type { CallbackContext, JsonObject, JsonValue } from "../../src/index.js";
import type { SplitSizes } from "./splits.js";

export interface InstructionMark {
  id: string;
  strict: boolean;
  loose: boolean;
}

export interface RowScore {
  primary: number;
  loose: number | null;
  f1: number | null;
  instructionStrictPasses: number;
  instructionStrictTotal: number;
  instructionLoosePasses: number;
  instructionLooseTotal: number;
  instructions: InstructionMark[];
}

export interface PublicExample {
  id: string;
  baselinePass: boolean;
}

export interface TokenBounds {
  min: number;
  max: number;
  defaultValue: number;
}

export interface ProposeRequest<T extends PublicExample> {
  current: string;
  rows: readonly T[];
  feedback: InstructionMark[][];
  mode: "improve" | "harmful";
}

export interface ModelAnswer {
  text: string;
  latencyMs: number;
}

export interface ModelRunner<T extends PublicExample> {
  answer(prompt: string, row: T, context: CallbackContext | null): Promise<ModelAnswer>;
  propose(input: ProposeRequest<T>, context: CallbackContext | null): Promise<string>;
}

export interface BenchmarkTask<T extends PublicExample> {
  id: "ifbench" | "hotpotqa";
  title: string;
  liveDir: string;
  promptCap: number;
  promptVersion: string;
  baselinePrompt: string;
  fullSizes: SplitSizes;
  smokeRows: number;
  /** True when the single propose call is preceded by a predict per optimization row. */
  feedbackPredicts: boolean;
  predict: TokenBounds;
  propose: TokenBounds;
  fixtureSizes: SplitSizes;
  fixtures(): { pool: T[]; heldOut: T[] };
  loadCache(): Promise<{ pool: T[]; heldOut: T[] }>;
  userText(row: T): string;
  datasetInput(row: T): JsonValue;
  datasetLabel(row: T): JsonValue;
  mockAnswer(prompt: string, row: T): string;
  scoreMany(items: { response: string; row: T }[]): Promise<RowScore[]>;
  predictPayload(row: T): string;
  proposePayload(current: string, rows: readonly T[], feedback: InstructionMark[][]): string;
  predictSchema(): JsonObject;
  proposeSchema(): JsonObject;
  emptyScore(): RowScore;
}

export function emptyInstructionScore(): RowScore {
  return {
    primary: 0,
    loose: null,
    f1: null,
    instructionStrictPasses: 0,
    instructionStrictTotal: 0,
    instructionLoosePasses: 0,
    instructionLooseTotal: 0,
    instructions: [],
  };
}
