/**
 * Read-only explanation of an acceptance decision log.
 * Checks that were not recorded stay null. A missing count is null, not 0.
 */
import { readFileSync } from "node:fs";
import { MAX_BOOTSTRAP_SAMPLES, minimumDecisiveFloor, DEFAULT_GATE } from "./acceptance-gate.js";

export interface ExplainedNoise {
  value: number | null;
  method: "paired-bootstrap" | "not_measured";
  items: number | null;
  calls: number | null;
}

export interface ExplainedCheck {
  round: number;
  outcome: "accepted" | "rejected" | "insufficient";
  reason: string;
  effect: number | null;
  lower: number | null;
  upper: number | null;
  threshold: number | null;
  decisive: number | null;
  required: number | null;
  noiseFloor: ExplainedNoise;
  effectiveThreshold: number | null;
  bindingThreshold: "minimum_effect" | "noise_floor" | "tie" | null;
}

export interface ExplainedCandidate {
  candidateId: string;
  promptHash: string;
  validation: ExplainedCheck | null;
  audit: ExplainedCheck | null;
}

export interface ExplainedSeed {
  seed: number;
  candidates: ExplainedCandidate[];
}

export interface ExplainedLog {
  seeds: ExplainedSeed[];
}

const OUTCOMES = new Set(["accepted", "rejected", "insufficient"]);

export function explainDecisionLog(path: string): ExplainedLog {
  return explainDecisionText(readFileSync(path, "utf8"));
}

export function explainDecisionText(text: string): ExplainedLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Decision log is not JSON.");
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Decision log is not an acceptance-decisions file.");
  const file = parsed as {
    schemaVersion?: unknown;
    kind?: unknown;
    seeds?: unknown;
  };
  if (file.schemaVersion !== 1 || file.kind !== "acceptance-decisions" || !Array.isArray(file.seeds))
    throw new Error("Decision log is not an acceptance-decisions file.");
  return { seeds: file.seeds.map((seed) => explainSeed(seed)) };
}

export function formatExplanation(log: ExplainedLog): string {
  const lines: string[] = [];
  for (const seed of log.seeds) {
    if (seed.candidates.length === 0) {
      lines.push(`seed ${seed.seed} no rounds`);
      continue;
    }
    for (const candidate of seed.candidates) {
      lines.push(formatCheck(seed.seed, candidate.candidateId, "validation", candidate.validation));
      lines.push(formatCheck(seed.seed, candidate.candidateId, "audit", candidate.audit));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatExplanationJson(log: ExplainedLog): string {
  return `${asciiJson(log)}\n`;
}

/** ASCII-only JSON. Non-ASCII and DEL match Python `json.dumps(..., ensure_ascii=True)`. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (character) => {
    return "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

/** Rule replay still accepts. Present decisive floors must match this value. */
export function replayDecisiveFloor(): number {
  return minimumDecisiveFloor(DEFAULT_GATE.confidence);
}

function explainSeed(value: unknown): ExplainedSeed {
  if (!value || typeof value !== "object") throw new Error("Decision log seed is malformed.");
  const seed = value as { seed?: unknown; rounds?: unknown };
  if (typeof seed.seed !== "number" || !Array.isArray(seed.rounds))
    throw new Error("Decision log seed is malformed.");
  const grouped = new Map<string, ExplainedCandidate>();
  const order: string[] = [];
  for (const round of seed.rounds) {
    const explained = explainRound(round, seed.seed);
    const key = `${explained.candidateId}\0${explained.promptHash}`;
    let candidate = grouped.get(key);
    if (!candidate) {
      candidate = {
        candidateId: explained.candidateId,
        promptHash: explained.promptHash,
        validation: null,
        audit: null,
      };
      grouped.set(key, candidate);
      order.push(key);
    }
    if (candidate[explained.split] !== null)
      throw new Error(
        `Seed ${seed.seed} repeats ${explained.split} for ${explained.candidateId}.`,
      );
    candidate[explained.split] = explained.check;
  }
  return {
    seed: seed.seed,
    candidates: order.map((key) => grouped.get(key)!),
  };
}

function explainRound(
  value: unknown,
  seed: number,
): {
  candidateId: string;
  promptHash: string;
  split: "validation" | "audit";
  check: ExplainedCheck;
} {
  if (!value || typeof value !== "object")
    throw new Error(`Seed ${seed} has a malformed round.`);
  const round = value as {
    round?: unknown;
    candidateId?: unknown;
    promptHash?: unknown;
    split?: unknown;
    rule?: unknown;
    decision?: unknown;
  };
  if (typeof round.round !== "number")
    throw new Error(`Seed ${seed} has a malformed round.`);
  if (typeof round.candidateId !== "string" || typeof round.promptHash !== "string")
    throw new Error(`Seed ${seed} round ${round.round} is missing its candidate.`);
  if (round.split !== "validation" && round.split !== "audit")
    throw new Error(`Seed ${seed} round ${round.round} has an unknown split.`);
  return {
    candidateId: round.candidateId,
    promptHash: round.promptHash,
    split: round.split,
    check: explainDecision(round.decision, round.rule, seed, round.round),
  };
}

function explainDecision(
  value: unknown,
  rule: unknown,
  seed: number,
  round: number,
): ExplainedCheck {
  if (!value || typeof value !== "object")
    throw new Error(`Seed ${seed} round ${round} has a malformed decision.`);
  const decision = value as {
    accept?: unknown;
    outcome?: unknown;
    reason?: unknown;
    effect?: unknown;
    lower?: unknown;
    upper?: unknown;
    decisive?: unknown;
    required?: unknown;
    noiseFloor?: unknown;
    effectiveThreshold?: unknown;
    bindingThreshold?: unknown;
  };
  if (typeof decision.accept !== "boolean" || typeof decision.reason !== "string")
    throw new Error(`Seed ${seed} round ${round} has a malformed decision.`);
  const outcome = decision.outcome === undefined ? outcomeFrom(decision.accept, decision.reason) : decision.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome))
    throw new Error(`Seed ${seed} round ${round} has an unknown outcome.`);
  if (outcome === "accepted" && decision.accept !== true)
    throw new Error(`Seed ${seed} round ${round} outcome does not match accept.`);
  if (outcome !== "accepted" && decision.accept !== false)
    throw new Error(`Seed ${seed} round ${round} outcome does not match accept.`);
  return {
    round,
    outcome: outcome as ExplainedCheck["outcome"],
    reason: decision.reason,
    effect: numberOrNull(decision.effect, seed, round, "effect"),
    lower: numberOrNull(decision.lower, seed, round, "lower"),
    upper: numberOrNull(decision.upper, seed, round, "upper"),
    threshold: ruleThreshold(rule, seed, round),
    decisive: countOrNull(decision, "decisive", seed, round),
    required: countOrNull(decision, "required", seed, round),
    noiseFloor: readNoise(decision.noiseFloor, seed, round),
    effectiveThreshold: readEffective(decision.effectiveThreshold, seed, round),
    bindingThreshold: readBinding(decision.bindingThreshold, seed, round),
  };
}

function outcomeFrom(accept: boolean, reason: string): ExplainedCheck["outcome"] {
  if (accept) return "accepted";
  if (reason === "insufficient_decisive") return "insufficient";
  return "rejected";
}

function numberOrNull(value: unknown, seed: number, round: number, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Seed ${seed} round ${round} has a non-finite ${name}.`);
  return value;
}

function countOrNull(
  decision: { decisive?: unknown; required?: unknown },
  name: "decisive" | "required",
  seed: number,
  round: number,
): number | null {
  if (!Object.hasOwn(decision, name) || decision[name] === null) return null;
  const value = decision[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`Seed ${seed} round ${round} has an invalid ${name} count.`);
  return value;
}

function readNoise(value: unknown, seed: number, round: number): ExplainedNoise {
  if (value === undefined || value === null) return notMeasuredNoise();
  if (!value || typeof value !== "object")
    throw new Error(`Seed ${seed} round ${round} has a malformed noise floor.`);
  const noise = value as {
    value?: unknown;
    method?: unknown;
    items?: unknown;
    calls?: unknown;
  };
  if (noise.method === "not_measured") {
    if (noise.value != null || noise.items != null || noise.calls != null)
      throw new Error(`Seed ${seed} round ${round} records an unmeasured noise floor as a number.`);
    return notMeasuredNoise();
  }
  if (noise.method !== "paired-bootstrap")
    throw new Error(`Seed ${seed} round ${round} has an unknown noise floor method.`);
  if (typeof noise.value !== "number" || !Number.isFinite(noise.value))
    throw new Error(`Seed ${seed} round ${round} has a non-finite noise floor.`);
  return {
    value: noise.value,
    method: "paired-bootstrap",
    items: noiseCount(noise.items, seed, round, "noise items"),
    calls: noise.calls == null ? null : noiseCount(noise.calls, seed, round, "noise calls"),
  };
}

function readEffective(value: unknown, seed: number, round: number): number | null {
  if (value === undefined) return null;
  return numberOrNull(value, seed, round, "effective threshold");
}

function readBinding(
  value: unknown,
  seed: number,
  round: number,
): ExplainedCheck["bindingThreshold"] {
  if (value === undefined || value === null) return null;
  if (value === "minimum_effect" || value === "noise_floor" || value === "tie") return value;
  throw new Error(`Seed ${seed} round ${round} has an unknown binding threshold.`);
}

function notMeasuredNoise(): ExplainedNoise {
  return { value: null, method: "not_measured", items: null, calls: null };
}

function noiseCount(value: unknown, seed: number, round: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`Seed ${seed} round ${round} has an invalid ${name} count.`);
  return value;
}

function ruleThreshold(rule: unknown, seed: number, round: number): number | null {
  if (!rule || typeof rule !== "object")
    throw new Error(`Seed ${seed} round ${round} has a rule outside the documented bounds.`);
  const value = (rule as { minimumEffect?: unknown; samples?: unknown; minimumDecisive?: unknown }).minimumEffect;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Seed ${seed} round ${round} has a rule outside the documented bounds.`);
  const samples = (rule as { samples?: unknown }).samples;
  if (
    typeof samples === "number" &&
    (!Number.isInteger(samples) || samples < 100 || samples > MAX_BOOTSTRAP_SAMPLES)
  )
    throw new Error(`Seed ${seed} round ${round} has a rule outside the documented bounds.`);
  const decisive = (rule as { minimumDecisive?: unknown }).minimumDecisive;
  if (
    decisive !== undefined &&
    (typeof decisive !== "number" || !Number.isInteger(decisive) || decisive < 0)
  )
    throw new Error(`Seed ${seed} round ${round} has a rule outside the documented bounds.`);
  return value;
}

function formatCheck(
  seed: number,
  candidateId: string,
  split: "validation" | "audit",
  check: ExplainedCheck | null,
): string {
  const id = showText(candidateId);
  if (!check) return `seed ${seed} ${id} ${split} null`;
  return [
    `seed ${seed}`,
    id,
    split,
    `round ${check.round}`,
    check.outcome,
    `reason ${showText(check.reason)}`,
    `effect ${show(check.effect)}`,
    `lower ${show(check.lower)}`,
    `upper ${show(check.upper)}`,
    `threshold ${show(check.threshold)}`,
    `decisive ${show(check.decisive)}`,
    `required ${show(check.required)}`,
    `noise ${show(check.noiseFloor.value)}`,
    `method ${check.noiseFloor.method}`,
    `noiseItems ${show(check.noiseFloor.items)}`,
    `calls ${show(check.noiseFloor.calls)}`,
    `effective ${show(check.effectiveThreshold)}`,
    `binding ${check.bindingThreshold ?? "null"}`,
  ].join(" ");
}

function show(value: number | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

/**
 * Quote text and escape every character outside printable ASCII (0x20–0x7E),
 * including DEL. Matches Python `json.dumps(..., ensure_ascii=True)`.
 */
function showText(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0");
  });
}
