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

export interface ProposeExampleOptions {
  seed?: number;
  predictions?: readonly (string | null)[];
  scores?: readonly (number | null)[];
}

export interface ProposeRequest<T extends PublicExample> {
  current: string;
  rows: readonly T[];
  feedback: InstructionMark[][];
  mode: "improve" | "harmful";
  exampleSeed?: number;
  predictions?: (string | null)[];
  scores?: (number | null)[];
}

export interface ModelAnswer {
  text: string;
  latencyMs: number;
  /** True when the call failed and the text is not a model answer. */
  failed?: boolean;
}

export interface PredictCall {
  arm: "baseline" | "strong-prompt" | "one-shot" | "controller";
  split:
    | "feedback"
    | "validation"
    | "audit"
    | "production"
    | "held-out"
    | "held-out-served"
    | "held-out-ungated"
    | "propose";
  /** Predictions expected for this arm and split. The fraction valve uses this denominator. */
  planned: number;
}

export interface ModelRunner<T extends PublicExample> {
  answer(
    prompt: string,
    row: T,
    context: CallbackContext | null,
    call?: PredictCall,
  ): Promise<ModelAnswer>;
  propose(input: ProposeRequest<T>, context: CallbackContext | null): Promise<string>;
  /** Throws when per-item failures have crossed the safety valve. */
  afterPredict?(): void;
}

export interface BenchmarkTask<T extends PublicExample> {
  id: "ifbench" | "hotpotqa";
  title: string;
  liveDir: string;
  promptCap: number;
  promptVersion: string;
  baselinePrompt: string;
  strongPromptVersion: string;
  /** Hand-written task prompt. Scored on the same held-out items as the other arms. */
  strongPrompt: string;
  fullSizes: SplitSizes;
  smokeRows: number;
  /**
   * True when the baseline is scored on the optimization rows before propose.
   * A seed scores that pass once and reuses it for later propose calls.
   */
  feedbackPredicts: boolean;
  /** Task-specific propose instruction. Falls back to the shared sentence. */
  proposeInstructions?: string;
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
  proposePayload(
    current: string,
    rows: readonly T[],
    feedback: InstructionMark[][],
    options?: ProposeExampleOptions,
  ): string;
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
