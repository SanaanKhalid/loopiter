/**
 * Shared sizes and the product improvement gate.
 * `0.05` is the autonomous onboarding default (src/onboarding.ts) and the
 * kb-qa policy value. These benchmarks do not lower it unless the CLI flag is set.
 */

export const PRODUCT_MINIMUM_IMPROVEMENT = 0.05;
export const PRODUCT_ALPHA = 0.05;
export const PROMPT_CAP = 8_000;
export const SMOKE_ROWS = 30;
export const FULL_SEEDS = [1, 2, 3, 4, 5] as const;
export const FULL_AUDIT_ROWS = 300;

export const FULL_SIZES = {
  optimization: 150,
  validation: 150,
  audit: FULL_AUDIT_ROWS,
  production: 150,
  heldOut: 300,
} as const;

/** Fixture controller run. Audit is large enough for a full-range paired Hoeffding gain. */
export const FIXTURE_SIZES = {
  optimization: 4,
  validation: 12,
  audit: 12,
  production: 4,
  heldOut: 12,
} as const;

export const TRUSTED_SOURCE = "verified-export";
export const CLOCK_START = "2026-04-15T12:00:00.000Z";
export const FOLLOW_MARKER = "[[loopiter-mock-follow]]";
export const HARM_MARKER = "[[loopiter-mock-harm]]";

export const PREDICT_TEXT_CAP = 16_384;
export const LIVE_INPUT_BYTES = 262_144;
export const PROPOSE_TOKEN_MAX = 4_096;

/**
 * Observed gain a paired Hoeffding audit must see before the lower bound
 * clears `minimumImprovement` on a [0, 1] score. At 300 rows, alpha 0.05,
 * and minimumImprovement 0.05 this is about 0.191 (19 percentage points).
 */
export function observedGainRequired(input: {
  auditRows: number;
  minimumImprovement: number;
  alpha?: number;
}): number {
  const alpha = input.alpha ?? PRODUCT_ALPHA;
  if (!Number.isInteger(input.auditRows) || input.auditRows < 1)
    throw new Error("Audit rows must be a positive integer.");
  if (!Number.isFinite(input.minimumImprovement) || input.minimumImprovement < 0)
    throw new Error("minimumImprovement must be a non-negative finite number.");
  if (!(alpha > 0 && alpha < 1)) throw new Error("alpha must be between 0 and 1.");
  const width = Math.sqrt((2 * Math.log(1 / alpha)) / input.auditRows);
  return input.minimumImprovement + width;
}

export function codePoints(value: string): number {
  return [...value].length;
}

export function assertWithinCap(fragment: string, cap: number): string {
  if (typeof fragment !== "string" || fragment.trim() === "")
    throw new Error("Prompt fragment is empty.");
  if (codePoints(fragment) > cap)
    throw new Error(`Prompt exceeds the ${cap}-character cap.`);
  return fragment;
}

export function appendMarker(baseline: string, marker: string, cap: number): string {
  return assertWithinCap(`${baseline}\n${marker}`, cap);
}
