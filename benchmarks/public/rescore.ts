/**
 * Aggregate sanity check for a saved public-benchmark report.
 * This is not a replay. The report has per-seed totals only, so each arm is
 * compared with an unpaired Newcombe interval, not the paired bootstrap the
 * gate uses on item scores.
 *
 *   node dist/benchmarks/public/rescore.js <report.json>
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  decideAcceptance,
  wilsonProportion,
  type GateDecision,
} from "../../src/acceptance-gate.js";

const CONFIDENCE = 0.9;
const MINIMUM_EFFECT = 0;

interface Total {
  successes: number;
  trials: number;
}

interface SeedRow {
  seed: number;
  baseline: Total;
  oneShot: Total;
  ungated: Total | null;
  served: Total;
}

export function rescoreReport(path: string): string {
  const report = JSON.parse(readFileSync(path, "utf8")) as {
    task?: string;
    harness?: string;
    perSeed?: unknown[];
  };
  const seeds = (report.perSeed ?? []).map(normalizeSeed);
  const lines = [
    "Aggregate sanity check. This is not a replay of the acceptance gate.",
    "Saved reports have per-seed totals only. Bounds are unpaired 90% Wilson intervals",
    "and the Newcombe lower bound of (arm − baseline). minimumEffect is 0.",
    `task ${report.task ?? "unknown"} harness ${report.harness ?? "unknown"}`,
    "",
    table(seeds),
    "",
  ];
  return lines.join("\n");
}

function table(seeds: SeedRow[]): string {
  const header = [
    "seed",
    "arm",
    "successes",
    "trials",
    "rate",
    "wilsonLower",
    "newcombeLower",
    "aggregate",
  ];
  const rows = [header.join("\t")];
  for (const seed of seeds) {
    rows.push(line(seed.seed, "baseline", seed.baseline, seed.baseline, "incumbent"));
    rows.push(line(seed.seed, "one-shot", seed.oneShot, seed.baseline, verdict(seed.oneShot, seed.baseline)));
    rows.push(
      seed.ungated
        ? line(seed.seed, "ungated", seed.ungated, seed.baseline, verdict(seed.ungated, seed.baseline))
        : missing(seed.seed, "ungated"),
    );
    rows.push(line(seed.seed, "served", seed.served, seed.baseline, verdict(seed.served, seed.baseline)));
  }
  if (seeds.length > 1) {
    const pooled = pool(seeds);
    rows.push(line("pooled", "baseline", pooled.baseline, pooled.baseline, "incumbent"));
    rows.push(line("pooled", "one-shot", pooled.oneShot, pooled.baseline, verdict(pooled.oneShot, pooled.baseline)));
    rows.push(
      pooled.ungated
        ? line("pooled", "ungated", pooled.ungated, pooled.baseline, verdict(pooled.ungated, pooled.baseline))
        : missing("pooled", "ungated"),
    );
    rows.push(line("pooled", "served", pooled.served, pooled.baseline, verdict(pooled.served, pooled.baseline)));
  }
  return rows.join("\n");
}

function line(
  seed: number | string,
  arm: string,
  armTotal: Total,
  baseline: Total,
  aggregate: string,
): string {
  const wilson = armTotal.trials > 0 ? wilsonProportion(armTotal.successes, armTotal.trials, CONFIDENCE) : null;
  const decision = arm === "baseline" ? null : decisionOf(armTotal, baseline);
  const cells = [
    String(seed),
    arm,
    String(armTotal.successes),
    String(armTotal.trials),
    wilson ? wilson.rate.toFixed(6) : "",
    wilson ? wilson.lower.toFixed(6) : "",
    decision?.lower === null || decision?.lower === undefined ? "" : decision.lower.toFixed(6),
    aggregate,
  ];
  return cells.join("\t");
}

function missing(seed: number | string, arm: string): string {
  return [String(seed), arm, "", "", "", "", "", "missing"].join("\t");
}

function verdict(arm: Total, baseline: Total): string {
  if (arm.trials <= 0 || baseline.trials <= 0) return "empty";
  const decision = decisionOf(arm, baseline);
  return decision.accept ? "accept" : "reject";
}

function decisionOf(arm: Total, baseline: Total): GateDecision {
  return decideAcceptance({
    unpaired: {
      candidateSuccesses: arm.successes,
      candidateTrials: arm.trials,
      incumbentSuccesses: baseline.successes,
      incumbentTrials: baseline.trials,
    },
    parameters: {
      minimumEffect: MINIMUM_EFFECT,
      confidence: CONFIDENCE,
      samples: 100,
      seed: 17,
      minimumItems: 0,
    },
  });
}

function pool(seeds: SeedRow[]): SeedRow {
  const sum = (pick: (row: SeedRow) => Total | null): Total | null => {
    let successes = 0;
    let trials = 0;
    for (const row of seeds) {
      const total = pick(row);
      if (!total) return null;
      successes += total.successes;
      trials += total.trials;
    }
    return { successes, trials };
  };
  return {
    seed: 0,
    baseline: sum((row) => row.baseline)!,
    oneShot: sum((row) => row.oneShot)!,
    ungated: sum((row) => row.ungated),
    served: sum((row) => row.served)!,
  };
}

function normalizeSeed(value: unknown): SeedRow {
  if (!value || typeof value !== "object") throw new Error("Report seed is not an object.");
  const row = value as Record<string, unknown>;
  const seed = row.seed;
  if (typeof seed !== "number") throw new Error("Report seed is missing its number.");
  if (row.controllerServed)
    return {
      seed,
      baseline: total(row.baseline),
      oneShot: total(row.oneShot),
      ungated: row.controllerUngated ? total(row.controllerUngated) : null,
      served: total(row.controllerServed),
    };
  const controller = object(row.controller, "controller");
  const oneShot = object(row.oneShot, "oneShot");
  return {
    seed,
    baseline: total(row.baseline),
    oneShot: total(oneShot.served ?? oneShot),
    ungated: controller.ungated ? total(controller.ungated) : null,
    served: total(controller.served),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`Report ${name} is missing.`);
  return value as Record<string, unknown>;
}

function total(value: unknown): Total {
  const row = object(value, "score");
  const successes = row.successes;
  const trials = row.trials;
  if (typeof successes !== "number" || typeof trials !== "number")
    throw new Error("Report score is missing successes or trials.");
  return { successes, trials };
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invoked) {
  const path = process.argv[2];
  if (!path || path.startsWith("--")) {
    console.error("Usage: node dist/benchmarks/public/rescore.js <report.json>");
    process.exit(2);
  }
  try {
    process.stdout.write(rescoreReport(path));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Rescore failed.");
    process.exit(1);
  }
}
