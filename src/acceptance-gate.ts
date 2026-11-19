/**
 * Acceptance rule for a candidate versus the incumbent on the same items.
 * The lower bound of a two-sided interval must clear `minimumEffect`.
 * That lower bound is the same cutoff as a one-sided bound at
 * `(1 + confidence) / 2` (0.95 when confidence is 0.90).
 * Paired scores use a fixed-seed percentile bootstrap. Items are sorted by id
 * before resampling, so the bound does not depend on input order.
 * `minimumItems` defaults to 0. A percentile interval on one or two items can
 * accept a one-sided difference; callers that need a floor set `minimumItems`
 * or the policy unit counts. Aggregate counts, used only when no paired items
 * are supplied, use a Newcombe interval built from Wilson bounds.
 */

/** Hard ceiling so a policy or a replayed log cannot allocate an unbounded sample list. */
export const MAX_BOOTSTRAP_SAMPLES = 100_000;

export interface GateItem {
  id: string;
  incumbent: number;
  candidate: number;
}

export interface UnpairedCounts {
  candidateSuccesses: number;
  candidateTrials: number;
  incumbentSuccesses: number;
  incumbentTrials: number;
}

export interface GateParameters {
  minimumEffect: number;
  confidence: number;
  samples: number;
  seed: number;
  /** Reject before the interval when the item count is below this. 0 leaves the guard off. */
  minimumItems: number;
}

export const DEFAULT_GATE: GateParameters = {
  minimumEffect: 0,
  confidence: 0.9,
  samples: 2_000,
  seed: 17,
  minimumItems: 0,
};

export type GateReason =
  | "accepted"
  | "below_minimum_effect"
  | "minimum_items"
  | "empty_sample";

export interface GateDecision {
  accept: boolean;
  reason: GateReason;
  lower: number | null;
  upper: number | null;
  effect: number;
  method: "paired-bootstrap" | "newcombe-wilson";
  itemCount: number;
}

/** Two-sided normal quantiles. Other levels use Acklam's inverse normal. */
const Z_95 = 1.959963984540054;
const Z_90 = 1.6448536269514722;

export function gateParameters(
  partial?: Partial<GateParameters> | null,
): GateParameters {
  return {
    minimumEffect: partial?.minimumEffect ?? DEFAULT_GATE.minimumEffect,
    confidence: partial?.confidence ?? DEFAULT_GATE.confidence,
    samples: partial?.samples ?? DEFAULT_GATE.samples,
    seed: partial?.seed ?? DEFAULT_GATE.seed,
    minimumItems: partial?.minimumItems ?? DEFAULT_GATE.minimumItems,
  };
}

export function decideAcceptance(input: {
  items?: readonly GateItem[];
  unpaired?: UnpairedCounts;
  direction?: "maximize" | "minimize";
  parameters?: Partial<GateParameters> | null;
}): GateDecision {
  const parameters = gateParameters(input.parameters);
  validateParameters(parameters);
  const direction = input.direction ?? "maximize";
  const sign = direction === "maximize" ? 1 : -1;
  const items = input.items ?? [];
  // Paired items take precedence. Unpaired counts are used only when no items are passed.
  if (items.length > 0) return decidePaired(items, sign, parameters);
  if (input.unpaired) return decideUnpaired(input.unpaired, sign, parameters);
  return {
    accept: false,
    reason: "empty_sample",
    lower: null,
    upper: null,
    effect: 0,
    method: "paired-bootstrap",
    itemCount: 0,
  };
}

function decidePaired(
  items: readonly GateItem[],
  sign: number,
  parameters: GateParameters,
): GateDecision {
  const ordered = orderPairedItems(items);
  const diffs: number[] = [];
  for (const item of ordered) diffs.push(sign * (item.candidate - item.incumbent));
  if (parameters.minimumItems > 0 && diffs.length < parameters.minimumItems)
    return blocked("minimum_items", meanOf(diffs), diffs.length, "paired-bootstrap");
  const interval = bootstrapMeanInterval(diffs, parameters);
  return finish(interval, diffs.length, "paired-bootstrap", parameters.minimumEffect);
}

function decideUnpaired(
  counts: UnpairedCounts,
  sign: number,
  parameters: GateParameters,
): GateDecision {
  validateCounts(counts);
  const itemCount = Math.min(counts.candidateTrials, counts.incumbentTrials);
  if (parameters.minimumItems > 0 && itemCount < parameters.minimumItems) {
    const effect =
      sign *
      (counts.candidateSuccesses / counts.candidateTrials -
        counts.incumbentSuccesses / counts.incumbentTrials);
    return blocked("minimum_items", effect, itemCount, "newcombe-wilson");
  }
  const interval = newcombeInterval(counts, parameters.confidence);
  const directed =
    sign === 1
      ? interval
      : { effect: -interval.effect, lower: -interval.upper, upper: -interval.lower };
  return finish(directed, itemCount, "newcombe-wilson", parameters.minimumEffect);
}

function finish(
  interval: { effect: number; lower: number; upper: number },
  itemCount: number,
  method: GateDecision["method"],
  minimumEffect: number,
): GateDecision {
  const accept = interval.lower > minimumEffect;
  return {
    accept,
    reason: accept ? "accepted" : "below_minimum_effect",
    lower: interval.lower,
    upper: interval.upper,
    effect: interval.effect,
    method,
    itemCount,
  };
}

function blocked(
  reason: "minimum_items",
  effect: number,
  itemCount: number,
  method: GateDecision["method"],
): GateDecision {
  return {
    accept: false,
    reason,
    lower: null,
    upper: null,
    effect,
    method,
    itemCount,
  };
}

export function wilsonProportion(
  successes: number,
  trials: number,
  confidence = DEFAULT_GATE.confidence,
): { rate: number; lower: number; upper: number } {
  if (!Number.isInteger(successes) || successes < 0)
    throw new Error("Wilson successes must be a non-negative integer.");
  if (!Number.isInteger(trials) || trials <= 0)
    throw new Error("Wilson trials must be a positive integer.");
  if (successes > trials) throw new Error("Wilson successes cannot exceed trials.");
  const z = normalZ(confidence);
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  const lower = successes === 0 ? 0 : clamp01(center - margin);
  const upper = successes === trials ? 1 : clamp01(center + margin);
  return { rate: p, lower, upper };
}

/** Newcombe hybrid score interval for the difference of two independent proportions. */
export function newcombeInterval(
  counts: UnpairedCounts,
  confidence = DEFAULT_GATE.confidence,
): { effect: number; lower: number; upper: number } {
  validateCounts(counts);
  const left = wilsonProportion(counts.candidateSuccesses, counts.candidateTrials, confidence);
  const right = wilsonProportion(counts.incumbentSuccesses, counts.incumbentTrials, confidence);
  const effect = left.rate - right.rate;
  const lower = effect - Math.hypot(left.rate - left.lower, right.upper - right.rate);
  const upper = effect + Math.hypot(left.upper - left.rate, right.rate - right.lower);
  return { effect, lower, upper };
}

export function bootstrapMeanInterval(
  values: readonly number[],
  parameters: Pick<GateParameters, "samples" | "seed" | "confidence">,
): { effect: number; lower: number; upper: number } {
  if (values.length === 0) throw new Error("Bootstrap needs at least one value.");
  const effect = meanOf(values);
  const rng = mulberry32(parameters.seed);
  const means: number[] = [];
  for (let sample = 0; sample < parameters.samples; sample++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++)
      sum += values[Math.floor(rng() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - parameters.confidence) / 2;
  return {
    effect,
    lower: percentile(means, tail),
    upper: percentile(means, 1 - tail),
  };
}

/** Deterministic PRNG in [0, 1). The same seed replays the same stream. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalZ(confidence: number): number {
  if (!(confidence > 0 && confidence < 1))
    throw new Error("Confidence must be between 0 and 1.");
  if (confidence === 0.95) return Z_95;
  if (confidence === 0.9) return Z_90;
  return inverseNorm(1 - (1 - confidence) / 2);
}

function validateParameters(parameters: GateParameters): void {
  if (!Number.isFinite(parameters.minimumEffect))
    throw new Error("minimumEffect must be finite.");
  if (!(parameters.confidence > 0 && parameters.confidence < 1))
    throw new Error("Confidence must be between 0 and 1.");
  if (
    !Number.isInteger(parameters.samples) ||
    parameters.samples < 100 ||
    parameters.samples > MAX_BOOTSTRAP_SAMPLES
  )
    throw new Error(
      `Bootstrap sample count must be an integer from 100 to ${MAX_BOOTSTRAP_SAMPLES}.`,
    );
  if (!Number.isSafeInteger(parameters.seed))
    throw new Error("Bootstrap seed must be an integer.");
  if (!Number.isInteger(parameters.minimumItems) || parameters.minimumItems < 0)
    throw new Error("minimumItems must be a non-negative integer.");
}

function validateCounts(counts: UnpairedCounts): void {
  for (const [name, successes, trials] of [
    ["candidate", counts.candidateSuccesses, counts.candidateTrials],
    ["incumbent", counts.incumbentSuccesses, counts.incumbentTrials],
  ] as const) {
    if (!Number.isInteger(successes) || successes < 0)
      throw new Error(`${name} successes must be a non-negative integer.`);
    if (!Number.isInteger(trials) || trials <= 0)
      throw new Error(`${name} trials must be a positive integer.`);
    if (successes > trials) throw new Error(`${name} successes cannot exceed trials.`);
  }
}

function orderPairedItems(items: readonly GateItem[]): GateItem[] {
  const ordered = [...items].sort((a, b) =>
    Buffer.compare(Buffer.from(String(a.id)), Buffer.from(String(b.id))),
  );
  const seen = new Set<string>();
  for (const item of ordered) {
    if (typeof item.id !== "string" || item.id.length === 0)
      throw new Error("Paired item id must be a non-empty string.");
    if (seen.has(item.id)) throw new Error(`Duplicate paired item id ${item.id}.`);
    seen.add(item.id);
    if (!Number.isFinite(item.incumbent) || !Number.isFinite(item.candidate))
      throw new Error("Paired scores must be finite.");
  }
  return ordered;
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low]!;
  const weight = index - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Acklam's inverse standard normal. Used for confidence levels other than 0.90 and 0.95. */
function inverseNorm(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(
        (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
      )
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}
