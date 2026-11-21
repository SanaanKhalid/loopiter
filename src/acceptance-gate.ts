/**
 * Acceptance rule for a candidate versus the incumbent on the same items.
 * The lower bound of a two-sided interval must clear `minimumEffect`.
 * That lower bound is the same cutoff as a one-sided bound at
 * `(1 + confidence) / 2` (0.95 when confidence is 0.90).
 * Paired scores use a fixed-seed percentile bootstrap. Items are sorted by id
 * before resampling, so the bound does not depend on input order.
 * `minimumItems` defaults to 0. A percentile interval on one or two items can
 * accept a one-sided difference; callers that need a floor set `minimumItems`
 * or the policy unit counts. `minimumDecisive` counts items whose scores
 * differ. Below that count the outcome is `insufficient` and the interval is
 * not used. 0 leaves that guard off. Aggregate counts, used only when no
 * paired items are supplied, use a Newcombe interval built from Wilson bounds.
 * An optional second incumbent score on every item measures run-to-run jitter.
 * The same bootstrap, seed, and id order produce an upper bound on the absolute
 * mean of that pair. The candidate must clear the larger of `minimumEffect`
 * and that bound. Omitting the second score records the floor as not measured.
 */

/**
 * Smallest unanimous decisive count whose one-sided sign-test tail falls under
 * the two-sided interval tail. At confidence 0.90 that tail is 0.05:
 * 2^-5 = 0.03125 is under it and 2^-4 = 0.0625 is not, so the floor is 5.
 * This is a sign-test floor. The percentile bootstrap can still clear a tie
 * on a smaller unanimous sample, which is why a confidence policy cannot set
 * a lower decisive minimum.
 */
export function minimumDecisiveFloor(confidence: number): number {
  if (!(confidence > 0 && confidence < 1))
    throw new Error("Confidence must be between 0 and 1.");
  const alpha = (1 - confidence) / 2;
  let count = 1;
  let tail = 0.5;
  while (tail >= alpha) {
    count += 1;
    tail /= 2;
    if (count > 64) throw new Error("Decisive floor is not usable at this confidence.");
  }
  return count;
}

/** Hard ceiling so a policy or a replayed log cannot allocate an unbounded sample list. */
export const MAX_BOOTSTRAP_SAMPLES = 100_000;

export interface GateItem {
  id: string;
  incumbent: number;
  candidate: number;
  /**
   * Second score of the same incumbent on this item. Present on every item
   * when the noise floor was measured, and absent on every item when it was not.
   */
  incumbentRepeat?: number;
}

export interface NoiseFloorRecord {
  /** Upper bound on |effect| of two incumbent runs. Null when the check did not run. */
  value: number | null;
  method: "paired-bootstrap" | "not_measured";
  /** Items in the re-score. Null when the check did not run. */
  items: number | null;
  /** Extra incumbent scores. One per item when the re-score ran. Null when unknown. */
  calls: number | null;
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
  /**
   * Paired items whose scores differ. Below this the outcome is insufficient
   * and the interval is not used. 0 or omitted leaves the guard off.
   */
  minimumDecisive?: number;
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
  | "insufficient_decisive"
  | "empty_sample";

export type GateOutcome = "accepted" | "rejected" | "insufficient";

export interface GateDecision {
  accept: boolean;
  outcome: GateOutcome;
  reason: GateReason;
  lower: number | null;
  upper: number | null;
  effect: number;
  method: "paired-bootstrap" | "newcombe-wilson";
  itemCount: number;
  /** Items whose scores differ. Null when this check did not count them. */
  decisive: number | null;
  /** Decisive items required. Null when that guard did not run. Never 0 for "off". */
  required: number | null;
  /** Run-to-run bound. `not_measured` and nulls when the incumbent was not re-scored. */
  noiseFloor: NoiseFloorRecord;
  /** max(minimumEffect, noiseFloor). Null when the noise check did not run. */
  effectiveThreshold: number | null;
  /** Which bar set the effective threshold. Null when the noise check did not run. */
  bindingThreshold: "minimum_effect" | "noise_floor" | "tie" | null;
  /**
   * Present when a caller recorded a retention check on this decision.
   * Absent on logs written before retention, which explain as not_measured.
   */
  retention?: RetentionDecision;
}

interface AppliedNoise {
  record: NoiseFloorRecord;
  effective: number | null;
  binding: GateDecision["bindingThreshold"];
  bar: number;
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
    ...(partial?.minimumDecisive !== undefined
      ? { minimumDecisive: partial.minimumDecisive }
      : {}),
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
    outcome: "rejected",
    reason: "empty_sample",
    lower: null,
    upper: null,
    effect: 0,
    method: "paired-bootstrap",
    itemCount: 0,
    decisive: null,
    required: null,
    ...noiseFields(absentNoise(parameters.minimumEffect)),
  };
}

function decidePaired(
  items: readonly GateItem[],
  sign: number,
  parameters: GateParameters,
): GateDecision {
  const ordered = orderPairedItems(items);
  const noise = noiseFromRepeats(ordered, parameters);
  const diffs: number[] = [];
  let decisive = 0;
  for (const item of ordered) {
    if (item.candidate !== item.incumbent) decisive += 1;
    diffs.push(sign * (item.candidate - item.incumbent));
  }
  const required = decisiveRequirement(parameters);
  if (required !== null && decisive < required)
    return insufficient(meanOf(diffs), diffs.length, decisive, required, "paired-bootstrap", noise);
  if (parameters.minimumItems > 0 && diffs.length < parameters.minimumItems)
    return blocked("minimum_items", meanOf(diffs), diffs.length, decisive, required, "paired-bootstrap", noise);
  const interval = bootstrapMeanInterval(diffs, parameters);
  return finish(interval, diffs.length, decisive, required, "paired-bootstrap", noise);
}

function decideUnpaired(
  counts: UnpairedCounts,
  sign: number,
  parameters: GateParameters,
): GateDecision {
  validateCounts(counts);
  const itemCount = Math.min(counts.candidateTrials, counts.incumbentTrials);
  // Unpaired counts have no per-item scores, so the decisive-item guard does not run.
  if (parameters.minimumItems > 0 && itemCount < parameters.minimumItems) {
    const effect =
      sign *
      (counts.candidateSuccesses / counts.candidateTrials -
        counts.incumbentSuccesses / counts.incumbentTrials);
    return blocked(
      "minimum_items",
      effect,
      itemCount,
      null,
      null,
      "newcombe-wilson",
      absentNoise(parameters.minimumEffect),
    );
  }
  const interval = newcombeInterval(counts, parameters.confidence);
  const directed =
    sign === 1
      ? interval
      : { effect: -interval.effect, lower: -interval.upper, upper: -interval.lower };
  return finish(
    directed,
    itemCount,
    null,
    null,
    "newcombe-wilson",
    absentNoise(parameters.minimumEffect),
  );
}

function decisiveRequirement(parameters: GateParameters): number | null {
  const required = parameters.minimumDecisive ?? 0;
  return required > 0 ? required : null;
}

function finish(
  interval: { effect: number; lower: number; upper: number },
  itemCount: number,
  decisive: number | null,
  required: number | null,
  method: GateDecision["method"],
  noise: AppliedNoise,
): GateDecision {
  const accept = interval.lower > noise.bar;
  return {
    accept,
    outcome: accept ? "accepted" : "rejected",
    reason: accept ? "accepted" : "below_minimum_effect",
    lower: interval.lower,
    upper: interval.upper,
    effect: interval.effect,
    method,
    itemCount,
    decisive,
    required,
    ...noiseFields(noise),
  };
}

function blocked(
  reason: "minimum_items",
  effect: number,
  itemCount: number,
  decisive: number | null,
  required: number | null,
  method: GateDecision["method"],
  noise: AppliedNoise,
): GateDecision {
  return {
    accept: false,
    outcome: "rejected",
    reason,
    lower: null,
    upper: null,
    effect,
    method,
    itemCount,
    decisive,
    required,
    ...noiseFields(noise),
  };
}

function insufficient(
  effect: number,
  itemCount: number,
  decisive: number,
  required: number,
  method: GateDecision["method"],
  noise: AppliedNoise,
): GateDecision {
  return {
    accept: false,
    outcome: "insufficient",
    reason: "insufficient_decisive",
    lower: null,
    upper: null,
    effect,
    method,
    itemCount,
    decisive,
    required,
    ...noiseFields(noise),
  };
}

/**
 * Upper bound on the absolute mean of two incumbent runs.
 * Diffs are second − first. The bound is the farther endpoint of the same
 * two-sided percentile interval the gate uses for a candidate. A constant
 * zero difference has bound 0. Items are sorted by UTF-8 id and the draw
 * restarts from `parameters.seed`.
 */
export function observedNoiseFloor(
  items: readonly { id: string; first: number; second: number }[],
  parameters: Pick<GateParameters, "samples" | "seed" | "confidence">,
): { value: number; effect: number; lower: number; upper: number; items: number } {
  if (items.length === 0) throw new Error("Noise floor needs at least one item.");
  const ordered = [...items].sort((a, b) =>
    Buffer.compare(Buffer.from(String(a.id)), Buffer.from(String(b.id))),
  );
  const seen = new Set<string>();
  const diffs: number[] = [];
  for (const item of ordered) {
    if (typeof item.id !== "string" || item.id.length === 0)
      throw new Error("Paired item id must be a non-empty string.");
    if (seen.has(item.id)) throw new Error(`Duplicate paired item id ${item.id}.`);
    seen.add(item.id);
    if (!Number.isFinite(item.first) || !Number.isFinite(item.second))
      throw new Error("Paired scores must be finite.");
    diffs.push(item.second - item.first);
  }
  const interval = bootstrapMeanInterval(diffs, parameters);
  return {
    value: Math.max(Math.abs(interval.lower), Math.abs(interval.upper)),
    effect: interval.effect,
    lower: interval.lower,
    upper: interval.upper,
    items: diffs.length,
  };
}

function noiseFromRepeats(items: readonly GateItem[], parameters: GateParameters): AppliedNoise {
  let present = 0;
  for (const item of items) if (item.incumbentRepeat !== undefined) present += 1;
  if (present === 0) return absentNoise(parameters.minimumEffect);
  if (present !== items.length)
    throw new Error("Incumbent repeat scores must cover every item.");
  const measured = observedNoiseFloor(
    items.map((item) => ({
      id: item.id,
      first: item.incumbent,
      second: item.incumbentRepeat as number,
    })),
    parameters,
  );
  return appliedNoise(parameters.minimumEffect, measured.value, measured.items);
}

function absentNoise(minimumEffect: number): AppliedNoise {
  return {
    record: { value: null, method: "not_measured", items: null, calls: null },
    effective: null,
    binding: null,
    bar: minimumEffect,
  };
}

function appliedNoise(minimumEffect: number, value: number, count: number): AppliedNoise {
  const binding =
    value > minimumEffect ? "noise_floor" : value < minimumEffect ? "minimum_effect" : "tie";
  const effective = Math.max(minimumEffect, value);
  return {
    record: { value, method: "paired-bootstrap", items: count, calls: count },
    effective,
    binding,
    bar: effective,
  };
}

function noiseFields(noise: AppliedNoise): Pick<
  GateDecision,
  "noiseFloor" | "effectiveThreshold" | "bindingThreshold"
> {
  return {
    noiseFloor: noise.record,
    effectiveThreshold: noise.effective,
    bindingThreshold: noise.binding,
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
  if (
    parameters.minimumDecisive !== undefined &&
    (!Number.isInteger(parameters.minimumDecisive) || parameters.minimumDecisive < 0)
  )
    throw new Error("minimumDecisive must be a non-negative integer.");
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

const PAIRED_ITEM_FIELDS = new Set(["id", "incumbent", "candidate", "incumbentRepeat"]);

function orderPairedItems(items: readonly GateItem[]): GateItem[] {
  const ordered = [...items].sort((a, b) =>
    Buffer.compare(Buffer.from(String(a.id)), Buffer.from(String(b.id))),
  );
  const seen = new Set<string>();
  for (const item of ordered) {
    for (const key of Object.keys(item)) {
      if (!PAIRED_ITEM_FIELDS.has(key))
        throw new Error(`Unknown paired item field ${key}.`);
    }
    if (typeof item.id !== "string" || item.id.length === 0)
      throw new Error("Paired item id must be a non-empty string.");
    if (seen.has(item.id)) throw new Error(`Duplicate paired item id ${item.id}.`);
    seen.add(item.id);
    if (
      !Number.isFinite(item.incumbent) ||
      !Number.isFinite(item.candidate) ||
      (item.incumbentRepeat !== undefined && !Number.isFinite(item.incumbentRepeat))
    )
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

/** How many retention decisions a ledger keeps. Older ones drop off the front. */
export const RETENTION_DECISION_LIMIT = 20;

/**
 * One control-split item score. The ledger stores these sorted by UTF-8 id.
 * The hosted ledger view reads this shape; it does not score items itself.
 */
export interface RetentionItemScore {
  id: string;
  score: number;
}

/**
 * Best control score remembered for one agent. `score` is the mean of `items`.
 * A later promotion replaces it only when the new control mean is strictly better.
 * Rollback does not write this record.
 */
export interface BestEverRecord {
  /** Version or candidate id that achieved `score`. */
  id: string;
  score: number;
  items: RetentionItemScore[];
}

/**
 * One retention check. `not_measured` uses nulls, never 0.
 * `retention_regression` blocks promotion. `insufficient` is not a pass.
 */
export interface RetentionDecision {
  outcome: "pass" | "retention_regression" | "insufficient" | "not_measured";
  reason: "pass" | "retention_regression" | "insufficient_decisive" | "not_measured";
  bestEverId: string | null;
  /** Lower bound of the objective-direction difference (candidate − bestEver). */
  lower: number | null;
  margin: number | null;
  /** Overlapping items. Null when the check did not measure them. */
  items: number | null;
}

export interface RetentionLedgerDecision extends RetentionDecision {
  candidateId: string;
}

/** Durable per-agent record stored beside controller state. */
export interface RetentionLedger {
  bestEver: BestEverRecord | null;
  decisions: RetentionLedgerDecision[];
}

export function notMeasuredRetention(): RetentionDecision {
  return {
    outcome: "not_measured",
    reason: "not_measured",
    bestEverId: null,
    lower: null,
    margin: null,
    items: null,
  };
}

export function emptyRetentionLedger(): RetentionLedger {
  return { bestEver: null, decisions: [] };
}

/**
 * Paired bootstrap of (candidate − bestEver), items sorted by UTF-8 id.
 * The lower bound uses the same seed, sample count, and confidence as the gate.
 * A lower bound below `-margin` is `retention_regression`.
 * Too few decisive overlaps is `insufficient`, not a pass.
 * No best-ever record, or no shared ids, is `not_measured` with nulls.
 */
export function decideRetention(input: {
  enabled: boolean;
  candidateItems: readonly RetentionItemScore[];
  bestEver: BestEverRecord | null;
  margin: number;
  direction?: "maximize" | "minimize";
  parameters: GateParameters;
}): RetentionDecision {
  if (!input.enabled) return notMeasuredRetention();
  validateParameters(input.parameters);
  if (!Number.isFinite(input.margin) || input.margin < 0)
    throw new Error("Retention margin must be a finite number >= 0.");
  const candidate = orderedScores(input.candidateItems, "candidate");
  if (!input.bestEver) return notMeasuredRetention();
  const best = orderedScores(input.bestEver.items, "best-ever");
  const bestById = new Map(best.map((item) => [item.id, item.score]));
  const paired = candidate.filter((item) => bestById.has(item.id));
  if (paired.length === 0) return notMeasuredRetention();
  const sign = (input.direction ?? "maximize") === "maximize" ? 1 : -1;
  const diffs: number[] = [];
  let decisive = 0;
  for (const item of paired) {
    const control = bestById.get(item.id)!;
    if (item.score !== control) decisive += 1;
    diffs.push(sign * (item.score - control));
  }
  const required = decisiveRequirement(input.parameters);
  if (required !== null && decisive < required) {
    return {
      outcome: "insufficient",
      reason: "insufficient_decisive",
      bestEverId: input.bestEver.id,
      lower: null,
      margin: input.margin,
      items: paired.length,
    };
  }
  const interval = bootstrapMeanInterval(diffs, input.parameters);
  if (interval.lower < -input.margin) {
    return {
      outcome: "retention_regression",
      reason: "retention_regression",
      bestEverId: input.bestEver.id,
      lower: interval.lower,
      margin: input.margin,
      items: paired.length,
    };
  }
  return {
    outcome: "pass",
    reason: "pass",
    bestEverId: input.bestEver.id,
    lower: interval.lower,
    margin: input.margin,
    items: paired.length,
  };
}

/**
 * Replace the record only when `items` has a strictly better control mean.
 * Maximize treats a larger mean as better. Minimize treats a smaller mean as better.
 * An equal mean keeps the current id. A missing record accepts the first score.
 */
export function nextBestEver(input: {
  current: BestEverRecord | null;
  candidateId: string;
  items: readonly RetentionItemScore[];
  direction?: "maximize" | "minimize";
}): BestEverRecord {
  if (typeof input.candidateId !== "string" || input.candidateId.length === 0)
    throw new Error("Best-ever id must be a non-empty string.");
  const items = orderedScores(input.items, "candidate");
  if (items.length === 0) throw new Error("Best-ever record needs at least one item.");
  const score = meanOf(items.map((item) => item.score));
  const next: BestEverRecord = { id: input.candidateId, score, items };
  if (!input.current) return next;
  const better =
    (input.direction ?? "maximize") === "minimize"
      ? score < input.current.score
      : score > input.current.score;
  return better ? next : input.current;
}

export function rememberRetentionDecision(
  ledger: RetentionLedger,
  decision: RetentionLedgerDecision,
): RetentionLedger {
  return {
    bestEver: ledger.bestEver,
    decisions: [...ledger.decisions, decision].slice(-RETENTION_DECISION_LIMIT),
  };
}

function orderedScores(
  items: readonly RetentionItemScore[],
  label: string,
): RetentionItemScore[] {
  const ordered = [...items].sort((a, b) =>
    Buffer.compare(Buffer.from(String(a.id)), Buffer.from(String(b.id))),
  );
  const seen = new Set<string>();
  for (const item of ordered) {
    if (typeof item.id !== "string" || item.id.length === 0)
      throw new Error(`Retention ${label} item id must be a non-empty string.`);
    if (seen.has(item.id)) throw new Error(`Duplicate retention ${label} item id ${item.id}.`);
    seen.add(item.id);
    if (!Number.isFinite(item.score))
      throw new Error(`Retention ${label} scores must be finite.`);
  }
  return ordered;
}
