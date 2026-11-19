/**
 * Decision log for the public-benchmark acceptance gate.
 * Replay reads the log and applies the same rule. It does not call a model.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decideAcceptance,
  type GateDecision,
  type GateItem,
  type GateParameters,
  type UnpairedCounts,
} from "../../src/acceptance-gate.js";

export interface PromptRef {
  id: string;
  promptHash: string;
}

export interface DecisionRound {
  round: number;
  candidateId: string;
  promptHash: string;
  incumbentId: string;
  incumbentPromptHash: string;
  split: "validation" | "audit";
  items?: GateItem[];
  unpaired?: UnpairedCounts;
  rule: GateParameters;
  decision: GateDecision;
}

export interface HeldOutTotal {
  successes: number;
  trials: number;
}

export interface SeedDecisionLog {
  seed: number;
  baseline: PromptRef;
  rounds: DecisionRound[];
  served: PromptRef;
  /** Production observation undid the last accepted deploy. The rule decisions stay. */
  observation?: "rolled_back";
  /** Optional totals for an offline sanity check. The rule does not read them. */
  heldOut?: Record<string, HeldOutTotal>;
}

export interface DecisionLogFile {
  schemaVersion: 1;
  kind: "acceptance-decisions";
  seeds: SeedDecisionLog[];
}

export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function emptySeedLog(seed: number, baselinePrompt: string): SeedDecisionLog {
  const baseline = { id: "baseline", promptHash: promptHash(baselinePrompt) };
  return { seed, baseline, rounds: [], served: { ...baseline } };
}

export function appendRound(
  log: SeedDecisionLog,
  input: {
    candidateId: string;
    promptHash: string;
    split: "validation" | "audit";
    items?: GateItem[];
    unpaired?: UnpairedCounts;
    rule: GateParameters;
  },
): DecisionRound {
  const served = settleSeed(log);
  const decision = decideAcceptance({
    ...(input.items ? { items: input.items } : {}),
    ...(input.unpaired ? { unpaired: input.unpaired } : {}),
    parameters: input.rule,
  });
  const round: DecisionRound = {
    round: log.rounds.length,
    candidateId: input.candidateId,
    promptHash: input.promptHash,
    incumbentId: served.id,
    incumbentPromptHash: served.promptHash,
    split: input.split,
    ...(input.items ? { items: input.items } : {}),
    ...(input.unpaired ? { unpaired: input.unpaired } : {}),
    rule: { ...input.rule },
    decision,
  };
  log.rounds.push(round);
  log.served = settleSeed(log);
  return round;
}

/** Incumbent after the last round that passed both validation and audit. */
export function settleSeed(
  log: Pick<SeedDecisionLog, "baseline" | "rounds" | "observation">,
): PromptRef {
  const steps: PromptRef[] = [{ ...log.baseline }];
  const validated = new Set<string>();
  for (const round of log.rounds) {
    if (round.split === "validation") {
      if (round.decision.accept) validated.add(round.candidateId);
      else validated.delete(round.candidateId);
    } else if (round.decision.accept && validated.has(round.candidateId)) {
      steps.push({ id: round.candidateId, promptHash: round.promptHash });
    }
  }
  if (log.observation === "rolled_back" && steps.length > 1) steps.pop();
  return steps[steps.length - 1]!;
}

export interface ReplaySeed {
  seed: number;
  served: PromptRef;
  baseline: PromptRef;
  matched: boolean;
  mismatches: string[];
}

export function replaySeed(log: SeedDecisionLog): ReplaySeed {
  const mismatches: string[] = [];
  let incumbent = { ...log.baseline };
  const validated = new Set<string>();
  for (const round of log.rounds) {
    if (
      round.incumbentId !== incumbent.id ||
      round.incumbentPromptHash !== incumbent.promptHash
    )
      mismatches.push(`seed ${log.seed} round ${round.round} incumbent`);
    const again = decideAcceptance({
      ...(round.items ? { items: round.items } : {}),
      ...(round.unpaired ? { unpaired: round.unpaired } : {}),
      parameters: round.rule,
    });
    if (
      again.accept !== round.decision.accept ||
      again.reason !== round.decision.reason ||
      again.method !== round.decision.method ||
      again.lower !== round.decision.lower ||
      again.effect !== round.decision.effect
    )
      mismatches.push(`seed ${log.seed} round ${round.round} decision`);
    if (round.split === "validation") {
      if (again.accept) validated.add(round.candidateId);
      else validated.delete(round.candidateId);
    } else if (again.accept && validated.has(round.candidateId)) {
      incumbent = { id: round.candidateId, promptHash: round.promptHash };
    }
  }
  const served = settleSeed(log);
  if (log.served.id !== served.id || log.served.promptHash !== served.promptHash)
    mismatches.push(`seed ${log.seed} served`);
  return {
    seed: log.seed,
    served,
    baseline: log.baseline,
    matched: mismatches.length === 0,
    mismatches,
  };
}

export function replayLogs(file: DecisionLogFile): ReplaySeed[] {
  if (file.schemaVersion !== 1 || file.kind !== "acceptance-decisions" || !Array.isArray(file.seeds))
    throw new Error("Decision log is not an acceptance-decisions file.");
  return file.seeds.map(replaySeed);
}

export function formatReplay(results: readonly ReplaySeed[]): string {
  const lines = results.map(
    (row) =>
      `seed ${row.seed} served ${row.served.id} baseline ${row.baseline.id}${row.matched ? "" : " MISMATCH"}`,
  );
  const failed = results.reduce((sum, row) => sum + (row.matched ? 0 : 1), 0);
  lines.push(
    failed === 0
      ? `${results.length} seed${results.length === 1 ? "" : "s"} matched the logged decisions.`
      : `${failed} seed${failed === 1 ? "" : "s"} did not match the logged decisions.`,
  );
  return `${lines.join("\n")}\n`;
}

export function decisionsBeside(reportPath: string): string {
  return reportPath.endsWith(".json")
    ? reportPath.replace(/\.json$/, ".decisions.json")
    : `${reportPath}.decisions.json`;
}

export function writeDecisionLog(path: string, seeds: readonly SeedDecisionLog[]): void {
  const file: DecisionLogFile = {
    schemaVersion: 1,
    kind: "acceptance-decisions",
    seeds: seeds.map(cloneSeed),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function readDecisionLog(path: string): DecisionLogFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as DecisionLogFile;
  if (parsed.schemaVersion !== 1 || parsed.kind !== "acceptance-decisions")
    throw new Error("Decision log is not an acceptance-decisions file.");
  return parsed;
}

function cloneSeed(log: SeedDecisionLog): SeedDecisionLog {
  return JSON.parse(JSON.stringify(log)) as SeedDecisionLog;
}
