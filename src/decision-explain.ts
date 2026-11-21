/**
 * Read-only explanation of an acceptance decision log.
 * Checks that were not recorded stay null. A missing count is null, not 0.
 */
import { readFileSync } from "node:fs";
import {
  MAX_BOOTSTRAP_SAMPLES,
  minimumDecisiveFloor,
  DEFAULT_GATE,
  loadRetentionLedger,
  type RetentionDecision,
  type RetentionItemScore,
  type RetentionLedger,
} from "./acceptance-gate.js";

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
  retention: ExplainedRetention;
}

export interface ExplainedRetention {
  outcome: RetentionDecision["outcome"];
  reason: string;
  bestEverId: string | null;
  lower: number | null;
  margin: number | null;
  items: number | null;
}

export interface RetentionStatus {
  bestEver: { id: string; score: number; items: RetentionItemScore[] } | null;
  decisions: (ExplainedRetention & { candidateId: string })[];
}

export interface RetentionTargetStatus extends RetentionStatus {
  id: string;
}

export interface RetentionReport {
  targets: RetentionTargetStatus[];
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
    retention: readRetention(
      (decision as { retention?: unknown }).retention,
      seed,
      round,
    ),
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

function notMeasuredRetentionView(): ExplainedRetention {
  return {
    outcome: "not_measured",
    reason: "not_measured",
    bestEverId: null,
    lower: null,
    margin: null,
    items: null,
  };
}

function readRetention(value: unknown, seed: number, round: number): ExplainedRetention {
  if (value === undefined || value === null) return notMeasuredRetentionView();
  return readRetentionFields(value, `Seed ${seed} round ${round}`);
}

function readRetentionFields(value: unknown, where: string): ExplainedRetention {
  if (!value || typeof value !== "object")
    throw new Error(`${where} has a malformed retention check.`);
  const row = value as {
    outcome?: unknown;
    reason?: unknown;
    bestEverId?: unknown;
    lower?: unknown;
    margin?: unknown;
    items?: unknown;
  };
  if (typeof row.outcome !== "string" || !RETENTION_OUTCOMES.has(row.outcome))
    throw new Error(`${where} has an unknown retention outcome.`);
  if (typeof row.reason !== "string")
    throw new Error(`${where} has a malformed retention check.`);
  if (row.outcome === "not_measured") {
    if (row.bestEverId != null || row.lower != null || row.margin != null || row.items != null)
      throw new Error(`${where} records an unmeasured retention check as a number.`);
    return notMeasuredRetentionView();
  }
  if (row.bestEverId !== null && typeof row.bestEverId !== "string")
    throw new Error(`${where} has a malformed best-ever id.`);
  const items = row.items;
  if (typeof items !== "number" || !Number.isInteger(items) || items < 1)
    throw new Error(`${where} has an invalid retention item count.`);
  const margin = row.margin;
  if (typeof margin !== "number" || !Number.isFinite(margin))
    throw new Error(`${where} has a non-finite retention margin.`);
  if (row.outcome === "insufficient") {
    if (row.lower != null) throw new Error(`${where} records an unused retention bound.`);
    return {
      outcome: "insufficient",
      reason: row.reason,
      bestEverId: typeof row.bestEverId === "string" ? row.bestEverId : null,
      lower: null,
      margin,
      items,
    };
  }
  if (typeof row.lower !== "number" || !Number.isFinite(row.lower))
    throw new Error(`${where} has a non-finite retention lower bound.`);
  return {
    outcome: row.outcome as "pass" | "retention_regression",
    reason: row.reason,
    bestEverId: typeof row.bestEverId === "string" ? row.bestEverId : null,
    lower: row.lower,
    margin,
    items,
  };
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
    `retention ${check.retention.outcome}`,
    `retentionReason ${showText(check.retention.reason)}`,
    `bestEver ${check.retention.bestEverId === null ? "null" : showText(check.retention.bestEverId)}`,
    `retentionLower ${show(check.retention.lower)}`,
    `margin ${show(check.retention.margin)}`,
    `retentionItems ${show(check.retention.items)}`,
  ].join(" ");
}

const RETENTION_OUTCOMES = new Set(["pass", "retention_regression", "insufficient", "not_measured"]);

export function emptyRetentionStatus(): RetentionStatus {
  return { bestEver: null, decisions: [] };
}

/** Read coordination retention rows from a v3 state file. Does not write. */
export function retentionReportFromState(text: string, namespace: string): RetentionReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("State file is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("State file is not a v3 store.");
  const file = parsed as { version?: unknown; namespaces?: unknown };
  if (file.version !== 3 || !file.namespaces || typeof file.namespaces !== "object" || Array.isArray(file.namespaces))
    throw new Error("State file is not a v3 store.");
  const bucket = (file.namespaces as Record<string, unknown>)[namespace];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
    throw new Error("State file has no such namespace.");
  const coordination = (bucket as { coordination?: unknown }).coordination;
  if (!coordination || typeof coordination !== "object" || Array.isArray(coordination))
    return { targets: [] };
  const targets: RetentionTargetStatus[] = [];
  for (const [id, row] of Object.entries(coordination)) {
    if (!id.startsWith("target:")) continue;
    if (!row || typeof row !== "object") continue;
    const data = (row as { data?: unknown }).data;
    if (!data || typeof data !== "object" || !("retention" in data)) continue;
    const ledger = loadRetentionLedger(normalizeLedger((data as { retention: unknown }).retention));
    targets.push(targetStatus(id, ledger));
  }
  targets.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  return { targets };
}

export function formatRetentionReport(report: RetentionReport): string {
  if (report.targets.length === 0) return "bestEver null score null items null\n";
  return `${report.targets
    .map((target) => `target ${showText(target.id)}\n${formatRetentionStatus(target).replace(/\n$/, "")}`)
    .join("\n")}\n`;
}

export function formatRetentionReportJson(report: RetentionReport): string {
  return `${asciiJson(report)}\n`;
}

function normalizeLedger(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as {
    bestEver?: unknown;
    best_ever?: unknown;
    decisions?: unknown;
  };
  const decisions = Array.isArray(row.decisions) ? row.decisions : row.decisions;
  const camel = row.best_ever === undefined && !usesSnakeDecision(decisions);
  if (camel) return { bestEver: row.bestEver ?? null, decisions: decisions ?? [] };
  return {
    bestEver: row.best_ever ?? row.bestEver ?? null,
    decisions: (Array.isArray(decisions) ? decisions : []).map((decision) => {
      if (!decision || typeof decision !== "object") return decision;
      const item = decision as {
        candidate_id?: unknown;
        candidateId?: unknown;
        best_ever_id?: unknown;
        bestEverId?: unknown;
        outcome?: unknown;
        reason?: unknown;
        lower?: unknown;
        margin?: unknown;
        items?: unknown;
      };
      return {
        candidateId: item.candidateId ?? item.candidate_id,
        outcome: item.outcome,
        reason: item.reason,
        bestEverId: item.bestEverId !== undefined ? item.bestEverId : item.best_ever_id ?? null,
        lower: item.lower ?? null,
        margin: item.margin ?? null,
        items: item.items ?? null,
      };
    }),
  };
}

function usesSnakeDecision(decisions: unknown): boolean {
  return (
    Array.isArray(decisions) &&
    decisions.some((decision) => !!decision && typeof decision === "object" && "candidate_id" in decision)
  );
}

function targetStatus(id: string, ledger: RetentionLedger): RetentionTargetStatus {
  return {
    id,
    bestEver: ledger.bestEver,
    decisions: ledger.decisions.map((decision) => ({
      candidateId: decision.candidateId,
      outcome: decision.outcome,
      reason: decision.reason,
      bestEverId: decision.bestEverId,
      lower: decision.lower,
      margin: decision.margin,
      items: decision.items,
    })),
  };
}

export function formatRetentionStatus(status: RetentionStatus): string {
  const lines = [
    `bestEver ${status.bestEver ? showText(status.bestEver.id) : "null"} score ${show(status.bestEver?.score ?? null)} items ${show(status.bestEver ? status.bestEver.items.length : null)}`,
  ];
  if (status.bestEver) {
    for (const item of status.bestEver.items)
      lines.push(`item ${showText(item.id)} ${show(item.score)}`);
  }
  for (const decision of status.decisions) {
    lines.push(
      [
        "decision",
        showText(decision.candidateId),
        decision.outcome,
        `reason ${showText(decision.reason)}`,
        `bestEver ${decision.bestEverId === null ? "null" : showText(decision.bestEverId)}`,
        `lower ${show(decision.lower)}`,
        `margin ${show(decision.margin)}`,
        `items ${show(decision.items)}`,
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatRetentionStatusJson(status: RetentionStatus): string {
  return `${asciiJson(status)}\n`;
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
