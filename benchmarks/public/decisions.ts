/**
 * Decision log for the public-benchmark acceptance gate.
 * Replay reads the log and applies the same rule. It does not call a model.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decideAcceptance,
  DEFAULT_GATE,
  MAX_BOOTSTRAP_SAMPLES,
  minimumDecisiveFloor,
  type GateDecision,
  type GateItem,
  type GateParameters,
  type NoiseFloorRecord,
  type UnpairedCounts,
} from "../../src/acceptance-gate.js";
import type { SplitSizes } from "./splits.js";

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
  /** Split sizes this seed was scored with. Absent on logs written before row counts were recorded. */
  splits?: SplitSizes;
  /** Set only after the harness checks the served prompt against this log. */
  complete?: boolean;
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
  const prior = log.rounds.find(
    (round) =>
      round.candidateId === input.candidateId &&
      round.split === input.split &&
      round.promptHash === input.promptHash,
  );
  if (prior) return prior;
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

/**
 * The served prompt is the accepted candidate with the highest paired effect
 * on its audit round. Equal effects keep the earlier round, then the id in
 * byte order. A rollback drops the latest accepted candidate.
 */
export function settleSeed(
  log: Pick<SeedDecisionLog, "baseline" | "rounds" | "observation">,
): PromptRef {
  const validated = new Set<string>();
  const accepted: { id: string; promptHash: string; effect: number; round: number }[] = [];
  for (const round of log.rounds) {
    if (round.split === "validation") {
      if (round.decision.accept) validated.add(round.candidateId);
      else validated.delete(round.candidateId);
    } else if (round.decision.accept && validated.has(round.candidateId)) {
      accepted.push({
        id: round.candidateId,
        promptHash: round.promptHash,
        effect: round.decision.effect,
        round: round.round,
      });
    }
  }
  if (log.observation === "rolled_back" && accepted.length > 0) {
    let latest = 0;
    for (let index = 1; index < accepted.length; index++)
      if (accepted[index]!.round > accepted[latest]!.round) latest = index;
    accepted.splice(latest, 1);
  }
  accepted.sort(
    (a, b) =>
      b.effect - a.effect ||
      a.round - b.round ||
      Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
  );
  const best = accepted[0];
  return best ? { id: best.id, promptHash: best.promptHash } : { ...log.baseline };
}

export interface ReplaySeed {
  seed: number;
  served: PromptRef;
  baseline: PromptRef;
  matched: boolean;
  mismatches: string[];
}

/** Current documented rule. A log that omits `minimumDecisive` still replays; that guard was off. */
export function documentedReplayRule(): GateParameters {
  return {
    ...DEFAULT_GATE,
    minimumDecisive: minimumDecisiveFloor(DEFAULT_GATE.confidence),
  };
}

export function replaySeed(
  log: SeedDecisionLog,
  expected: GateParameters = documentedReplayRule(),
): ReplaySeed {
  const mismatches: string[] = [];
  if (log.complete === false) mismatches.push(`seed ${log.seed} incomplete`);
  for (let index = 0; index < log.rounds.length; index++) {
    const round = log.rounds[index]!;
    const incumbent = settleSeed({
      baseline: log.baseline,
      rounds: log.rounds.slice(0, index),
    });
    if (!sameRule(round.rule, expected))
      mismatches.push(`seed ${log.seed} round ${round.round} rule`);
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
      again.effect !== round.decision.effect ||
      (round.decision.outcome !== undefined && again.outcome !== round.decision.outcome) ||
      (round.decision.decisive !== undefined && again.decisive !== round.decision.decisive) ||
      (round.decision.required !== undefined && again.required !== round.decision.required) ||
      !sameNoise(again, round.decision)
    )
      mismatches.push(`seed ${log.seed} round ${round.round} decision`);
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
  return file.seeds.map((seed) => replaySeed(seed));
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Decision log is not JSON.");
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Decision log is not an acceptance-decisions file.");
  const file = parsed as DecisionLogFile;
  if (file.schemaVersion !== 1 || file.kind !== "acceptance-decisions" || !Array.isArray(file.seeds))
    throw new Error("Decision log is not an acceptance-decisions file.");
  file.seeds.forEach(validateSeed);
  return file;
}

function sameRule(actual: GateParameters, expected: GateParameters): boolean {
  if (
    actual.minimumEffect !== expected.minimumEffect ||
    actual.confidence !== expected.confidence ||
    actual.samples !== expected.samples ||
    actual.seed !== expected.seed ||
    actual.minimumItems !== expected.minimumItems
  )
    return false;
  // Logs written before the decisive floor omit the field. Recompute treats that as off.
  if (actual.minimumDecisive === undefined) return true;
  return actual.minimumDecisive === (expected.minimumDecisive ?? 0);
}

function validateSeed(log: SeedDecisionLog): void {
  if (!log || typeof log !== "object" || typeof log.seed !== "number" || !Array.isArray(log.rounds))
    throw new Error("Decision log seed is malformed.");
  requireRef(log.baseline, "baseline");
  requireRef(log.served, "served");
  if (log.splits !== undefined) requireSplitSizes(log.splits, log.seed);
  const ids = new Set<string>();
  for (const round of log.rounds) {
    if (!round || typeof round.round !== "number")
      throw new Error(`Seed ${log.seed} has a malformed round.`);
    if (typeof round.candidateId !== "string" || typeof round.promptHash !== "string")
      throw new Error(`Seed ${log.seed} round ${round.round} is missing its candidate.`);
    if (round.split !== "validation" && round.split !== "audit")
      throw new Error(`Seed ${log.seed} round ${round.round} has an unknown split.`);
    requireRule(round.rule, log.seed, round.round);
    requireDecision(round.decision, log.seed, round.round);
    if (round.items) {
      ids.clear();
      for (const item of round.items) {
        if (!item || typeof item.id !== "string" || !item.id)
          throw new Error(`Seed ${log.seed} round ${round.round} has an item without an id.`);
        if (ids.has(item.id))
          throw new Error(`Seed ${log.seed} round ${round.round} repeats item ${item.id}.`);
        ids.add(item.id);
        if (
          !Number.isFinite(item.incumbent) ||
          !Number.isFinite(item.candidate) ||
          (item.incumbentRepeat !== undefined && !Number.isFinite(item.incumbentRepeat))
        )
          throw new Error(`Seed ${log.seed} round ${round.round} has a non-finite score.`);
      }
    }
  }
}

function sameNoise(again: GateDecision, stored: GateDecision): boolean {
  const noise = (stored as { noiseFloor?: NoiseFloorRecord }).noiseFloor;
  if (noise === undefined) {
    return (
      again.noiseFloor.method === "not_measured" &&
      again.effectiveThreshold === null &&
      again.bindingThreshold === null
    );
  }
  const effective = (stored as { effectiveThreshold?: number | null }).effectiveThreshold;
  const binding = (stored as { bindingThreshold?: GateDecision["bindingThreshold"] }).bindingThreshold;
  return (
    noise.method === again.noiseFloor.method &&
    noise.value === again.noiseFloor.value &&
    noise.items === again.noiseFloor.items &&
    noise.calls === again.noiseFloor.calls &&
    (effective === undefined ? again.effectiveThreshold === null : effective === again.effectiveThreshold) &&
    (binding === undefined ? again.bindingThreshold === null : binding === again.bindingThreshold)
  );
}

function requireSplitSizes(sizes: SplitSizes, seed: number): void {
  const names = ["optimization", "validation", "audit", "production", "heldOut"] as const;
  for (const name of names) {
    const value = sizes[name];
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`Seed ${seed} split ${name} is not a positive integer.`);
  }
}

function requireRef(value: PromptRef, name: string): void {
  if (!value || typeof value.id !== "string" || typeof value.promptHash !== "string")
    throw new Error(`Decision log ${name} is malformed.`);
}

function requireRule(rule: GateParameters, seed: number, round: number): void {
  if (
    !rule ||
    !Number.isFinite(rule.minimumEffect) ||
    !(rule.confidence > 0 && rule.confidence < 1) ||
    !Number.isInteger(rule.samples) ||
    rule.samples < 100 ||
    rule.samples > MAX_BOOTSTRAP_SAMPLES ||
    !Number.isSafeInteger(rule.seed) ||
    !Number.isInteger(rule.minimumItems) ||
    rule.minimumItems < 0 ||
    (rule.minimumDecisive !== undefined &&
      (!Number.isInteger(rule.minimumDecisive) || rule.minimumDecisive < 0))
  )
    throw new Error(`Seed ${seed} round ${round} has a rule outside the documented bounds.`);
}

function requireDecision(decision: GateDecision, seed: number, round: number): void {
  if (
    !decision ||
    typeof decision.accept !== "boolean" ||
    typeof decision.reason !== "string" ||
    (decision.method !== "paired-bootstrap" && decision.method !== "newcombe-wilson")
  )
    throw new Error(`Seed ${seed} round ${round} has a malformed decision.`);
  if (
    decision.outcome !== undefined &&
    decision.outcome !== "accepted" &&
    decision.outcome !== "rejected" &&
    decision.outcome !== "insufficient"
  )
    throw new Error(`Seed ${seed} round ${round} has an unknown outcome.`);
  for (const name of ["decisive", "required"] as const) {
    const value = decision[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new Error(`Seed ${seed} round ${round} has an invalid ${name} count.`);
  }
  const noise = (decision as { noiseFloor?: NoiseFloorRecord | null }).noiseFloor;
  if (noise === undefined || noise === null) return;
  if (noise.method !== "paired-bootstrap" && noise.method !== "not_measured")
    throw new Error(`Seed ${seed} round ${round} has an unknown noise floor method.`);
  if (noise.method === "not_measured") {
    if (noise.value != null || noise.items != null || noise.calls != null)
      throw new Error(`Seed ${seed} round ${round} records an unmeasured noise floor as a number.`);
    return;
  }
  if (typeof noise.value !== "number" || !Number.isFinite(noise.value))
    throw new Error(`Seed ${seed} round ${round} has a non-finite noise floor.`);
  if (typeof noise.items !== "number" || !Number.isInteger(noise.items) || noise.items < 0)
    throw new Error(`Seed ${seed} round ${round} has an invalid noise items count.`);
  if (
    noise.calls != null &&
    (typeof noise.calls !== "number" || !Number.isInteger(noise.calls) || noise.calls < 0)
  )
    throw new Error(`Seed ${seed} round ${round} has an invalid noise calls count.`);
  const binding = (decision as { bindingThreshold?: unknown }).bindingThreshold;
  if (
    binding !== undefined &&
    binding !== null &&
    binding !== "minimum_effect" &&
    binding !== "noise_floor" &&
    binding !== "tie"
  )
    throw new Error(`Seed ${seed} round ${round} has an unknown binding threshold.`);
}

function cloneSeed(log: SeedDecisionLog): SeedDecisionLog {
  return JSON.parse(JSON.stringify(log)) as SeedDecisionLog;
}
