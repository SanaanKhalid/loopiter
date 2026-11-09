/**
 * Simulated spend. Token counts are multiplied by a configurable price table
 * and accumulated in integer micro-USD (1e-6 USD), rounded half away from
 * zero per call. Phase 1 can replace the placeholder rates; this module
 * never contacts a provider.
 */

export interface ModelPrice {
  /** USD charged per 1,000,000 input tokens. */
  inputUsdPerMillion: number;
  /** USD charged per 1,000,000 output tokens. */
  outputUsdPerMillion: number;
}

export interface PriceTable {
  version: string;
  currency: "USD";
  note: string;
  models: Record<string, ModelPrice>;
}

export const DEFAULT_MODEL = "gpt-5.4-mini";

/** Placeholder rates, not a provider invoice. $1 and $4 per million tokens. */
export const defaultPriceTable: PriceTable = {
  version: "phase0-placeholder-v1",
  currency: "USD",
  note: "Placeholder rates for simulated accounting. Not a provider price list. Replace this table for a later live run.",
  models: {
    [DEFAULT_MODEL]: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 4,
    },
  },
};

/** Fixed mock footprints so a seed replays the same bill. */
export const TOKEN_FOOTPRINT = {
  propose: { input: 120, output: 40 },
  predict: { input: 80, output: 12 },
} as const;

export const SIMULATED_LATENCY_MS = {
  propose: 40,
  predict: 15,
} as const;

export type MeteredKind = keyof typeof TOKEN_FOOTPRINT;

export function costMicroUsd(
  usage: { input: number; output: number },
  price: ModelPrice,
): number {
  if (
    !Number.isInteger(usage.input) ||
    !Number.isInteger(usage.output) ||
    usage.input < 0 ||
    usage.output < 0
  )
    throw new Error("Token counts must be non-negative integers.");
  for (const rate of [price.inputUsdPerMillion, price.outputUsdPerMillion])
    if (!Number.isFinite(rate) || rate < 0)
      throw new Error("Token prices must be non-negative finite numbers.");
  const micro =
    usage.input * price.inputUsdPerMillion +
    usage.output * price.outputUsdPerMillion;
  if (!Number.isFinite(micro)) throw new Error("Non-finite simulated cost.");
  return Math.round(micro);
}

export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("Invalid USD amount.");
  return Math.round(usd * 1_000_000);
}

/** Exact 6-decimal USD from integer micro-USD. */
export function formatUsd(microUsd: number): string {
  if (!Number.isInteger(microUsd))
    throw new Error("USD formatter expects integer micro-USD.");
  const sign = microUsd < 0 ? "-" : "";
  const abs = Math.abs(microUsd);
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, "0");
  return `${sign}${whole}.${fraction}`;
}

export type SpendStopReason = "per_run_cap" | "total_cap";

export interface SpendCaps {
  perRunMicroUsd: number;
  totalMicroUsd: number;
}

/**
 * Enforces per-run and total simulated-spend caps.
 * A call that would exceed either cap is refused and not added.
 * Per-run is checked first when both would be exceeded.
 */
export class SpendLedger {
  totalMicroUsd = 0;
  runMicroUsd = 0;
  runCalls = 0;
  runLatencyMs = 0;
  totalCalls = 0;
  totalLatencyMs = 0;
  stopReason: SpendStopReason | null = null;
  refusedCalls = 0;

  constructor(readonly caps: SpendCaps) {
    if (
      !Number.isInteger(caps.perRunMicroUsd) ||
      !Number.isInteger(caps.totalMicroUsd) ||
      caps.perRunMicroUsd <= 0 ||
      caps.totalMicroUsd <= 0
    )
      throw new Error("Spend caps must be positive integer micro-USD.");
    if (caps.perRunMicroUsd > caps.totalMicroUsd)
      throw new Error("Per-run cap cannot exceed the total cap.");
  }

  beginRun(): void {
    this.runMicroUsd = 0;
    this.runCalls = 0;
    this.runLatencyMs = 0;
    this.stopReason = null;
    this.refusedCalls = 0;
  }

  /** Returns false and records the cap when the charge would exceed it. */
  tryCharge(microUsd: number, latencyMs: number): boolean {
    if (!Number.isInteger(microUsd) || microUsd <= 0)
      throw new Error("Charges must be positive integer micro-USD.");
    if (!Number.isInteger(latencyMs) || latencyMs < 0)
      throw new Error("Latency must be a non-negative integer.");
    if (this.runMicroUsd + microUsd > this.caps.perRunMicroUsd) {
      this.stopReason = "per_run_cap";
      this.refusedCalls += 1;
      return false;
    }
    if (this.totalMicroUsd + microUsd > this.caps.totalMicroUsd) {
      this.stopReason = "total_cap";
      this.refusedCalls += 1;
      return false;
    }
    this.runMicroUsd += microUsd;
    this.totalMicroUsd += microUsd;
    this.runCalls += 1;
    this.totalCalls += 1;
    this.runLatencyMs += latencyMs;
    this.totalLatencyMs += latencyMs;
    return true;
  }
}

export function quote(
  kind: MeteredKind,
  table: PriceTable,
  model = DEFAULT_MODEL,
): { microUsd: number; latencyMs: number; tokens: number } {
  const price = table.models[model];
  if (!price) throw new Error(`Price table has no model ${model}.`);
  const usage = TOKEN_FOOTPRINT[kind];
  return {
    microUsd: costMicroUsd(usage, price),
    latencyMs: SIMULATED_LATENCY_MS[kind],
    tokens: usage.input + usage.output,
  };
}
