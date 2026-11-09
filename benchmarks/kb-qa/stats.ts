/** Seeded intervals for the offline benchmark. No Math.random. */

/** Two-sided 95% normal quantile, Φ^{-1}(0.975). */
export const WILSON_Z_95 = 1.959963984540054;

export interface ProportionInterval {
  successes: number;
  trials: number;
  rate: number;
  lower: number;
  upper: number;
  confidence: number;
  method: "wilson";
  z: number;
}

/**
 * Wilson score interval for a binomial proportion.
 * Bounds are clipped to [0, 1]. For zero trials the interval is undefined.
 * With k = 0 the lower bound is 0; with k = n the upper bound is 1.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  confidence = 0.95,
  z = confidence === 0.95 ? WILSON_Z_95 : undefined,
): ProportionInterval {
  if (!Number.isInteger(successes) || successes < 0)
    throw new Error("Wilson successes must be a non-negative integer.");
  if (!Number.isInteger(trials) || trials <= 0)
    throw new Error("Wilson trials must be a positive integer.");
  if (successes > trials)
    throw new Error("Wilson successes cannot exceed trials.");
  if (!(confidence > 0 && confidence < 1))
    throw new Error("Confidence must be between 0 and 1.");
  if (z === undefined)
    throw new Error(
      "Pass z for confidence levels other than 0.95. This harness does not estimate quantiles.",
    );
  if (!(z > 0)) throw new Error("Wilson z must be positive.");
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denom;
  // Zero successes and all successes have closed endpoints. Snap them so
  // floating-point noise cannot report a bound outside {0, 1}.
  const lower = successes === 0 ? 0 : clamp01(center - margin);
  const upper = successes === trials ? 1 : clamp01(center + margin);
  return {
    successes,
    trials,
    rate: p,
    lower,
    upper,
    confidence,
    method: "wilson",
    z,
  };
}

export interface BootstrapInterval {
  mean: number;
  lower: number;
  upper: number;
  confidence: number;
  samples: number;
  seed: number;
  method: "seed-bootstrap-percentile";
  unit: "seed";
}

/**
 * Percentile bootstrap of the mean. `values` are one observation per seed.
 * Resamples are drawn with a mulberry32 generator. Endpoints use linear
 * interpolation between order statistics (NumPy's percentile default, type 7):
 * index = p * (samples - 1).
 */
export function bootstrapMeanInterval(
  values: readonly number[],
  options: { samples: number; seed: number; confidence?: number },
): BootstrapInterval {
  if (values.length === 0) throw new Error("Bootstrap needs at least one seed.");
  for (const value of values)
    if (!Number.isFinite(value)) throw new Error("Bootstrap values must be finite.");
  const samples = options.samples;
  if (!Number.isInteger(samples) || samples < 100)
    throw new Error("Bootstrap sample count must be an integer of at least 100.");
  if (!Number.isInteger(options.seed))
    throw new Error("Bootstrap seed must be an integer.");
  const confidence = options.confidence ?? 0.95;
  if (!(confidence > 0 && confidence < 1))
    throw new Error("Confidence must be between 0 and 1.");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const rng = mulberry32(options.seed);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const index = Math.floor(rng() * values.length);
      sum += values[index]!;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  return {
    mean,
    lower: percentile(means, alpha / 2),
    upper: percentile(means, 1 - alpha / 2),
    confidence,
    samples,
    seed: options.seed,
    method: "seed-bootstrap-percentile",
    unit: "seed",
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

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
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
