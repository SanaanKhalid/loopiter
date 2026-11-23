import type {
  AutonomyPolicy,
  ChangeSchema,
  Comparison,
  DatasetRow,
  DatasetSnapshot,
  MetricGate,
} from "./improvement-contracts.js";
import type { JsonValue } from "./contracts.js";
import { validateCaps } from "./run-caps.js";
import {
  enumeration,
  fail,
  finite,
  hash,
  integer,
  json,
  nonempty,
  object,
  timestamp,
} from "./utils.js";
import {
  decideAcceptance,
  decideRetention,
  gateParameters,
  MAX_BOOTSTRAP_SAMPLES,
  minimumDecisiveFloor,
  notMeasuredRetention,
  type BestEverRecord,
  type GateDecision,
  type RetentionDecision,
} from "./acceptance-gate.js";
import { fields, target } from "./validation.js";

export function validateSchema(schema: ChangeSchema): void {
  fields(schema, [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "minimum",
    "maximum",
    "maxLength",
  ]);
  enumeration(
    schema.type,
    ["object", "string", "number", "boolean"],
    "schema type",
  );
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    fail("invalid_policy", "Empty enum.");
  if (schema.type === "object") {
    object(schema.properties, "schema properties");
    if (
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required)
    )
      fail(
        "invalid_policy",
        "Objects require explicit required fields and additionalProperties:false.",
      );
    for (const name of schema.required)
      if (!Object.hasOwn(schema.properties!, name))
        fail("invalid_policy", "Unknown required field.");
    for (const value of Object.values(schema.properties!))
      validateSchema(value);
  }
  if (schema.minimum !== undefined) finite(schema.minimum, "minimum");
  if (schema.maximum !== undefined) finite(schema.maximum, "maximum");
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  )
    fail("invalid_policy", "Reversed bounds.");
  if (schema.maxLength !== undefined) integer(schema.maxLength, "maxLength");
  if (
    schema.type === "string" &&
    !schema.enum &&
    schema.maxLength === undefined
  )
    fail(
      "invalid_policy",
      "Prompt fragments require an explicit length bound.",
    );
  if (
    schema.type === "number" &&
    !schema.enum &&
    (schema.minimum === undefined || schema.maximum === undefined)
  )
    fail("invalid_policy", "Numeric changes require explicit bounds.");
}
export function validateChange(value: JsonValue, schema: ChangeSchema): void {
  json(value);
  if (schema.enum && !schema.enum.some((v) => hash(v) === hash(value)))
    fail("forbidden_change", "Value outside enum.");
  if (schema.type === "object") {
    object(value, "change");
    for (const name of schema.required!)
      if (!Object.hasOwn(value, name))
        fail("forbidden_change", `Missing ${name}.`);
    for (const [key, v] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties!, key))
        fail("forbidden_change", `Field ${key} is not permitted.`);
      validateChange(v as JsonValue, schema.properties![key]!);
    }
  } else if (typeof value !== schema.type)
    fail("forbidden_change", "Change type mismatch.");
  if (typeof value === "number") {
    finite(value, "change");
    if (
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      fail("forbidden_change", "Change outside bounds.");
  }
  if (
    typeof value === "string" &&
    schema.maxLength !== undefined &&
    Array.from(value).length > schema.maxLength
  )
    fail("forbidden_change", "String limit exceeded.");
}
function gates(g: MetricGate[]): void {
  if (!Array.isArray(g) || !g.length)
    fail("invalid_policy", "Independent guardrails required.");
  for (const item of g) {
    fields(item, ["metric", "comparator", "value"]);
    nonempty(item.metric, "metric");
    enumeration(item.comparator, ["gte", "lte"], "comparator");
    finite(item.value, "gate");
  }
}
export function validatePolicy(p: AutonomyPolicy): void {
  json(p);
  fields(p, [
    "version",
    "target",
    "changeSchema",
    "objective",
    "guardrails",
    "trustedSources",
    "minimumNewUnits",
    "minimumValidationUnits",
    "minimumAuditUnits",
    "outcomeMaturityMs",
    "maximumRows",
    "daily",
    "caps",
    "callbackReservation",
    "cooldownMs",
    "rollout",
    "observation",
    "onInsufficientEvidence",
    "onUncertainDeployment",
    "maximumCandidates",
    "maximumProposalCalls",
    "maximumConsecutiveFailures",
    "auditMethod",
  ]);
  nonempty(p.version, "policy version");
  target(p.target);
  enumeration(p.target.kind, ["prompt", "routing", "agent_release"], "autonomous target");
  validateSchema(p.changeSchema);
  fields(p.objective, [
    "metric",
    "direction",
    "minimumImprovement",
    "range",
    "alpha",
    "acceptance",
    "minimumEffect",
    "confidence",
    "bootstrapSamples",
    "bootstrapSeed",
    "minimumItems",
    "minimumValidationDecisive",
    "minimumAuditDecisive",
    "noiseFloor",
    "retention",
  ]);
  nonempty(p.objective.metric, "objective");
  enumeration(p.objective.direction, ["maximize", "minimize"], "direction");
  finite(p.objective.minimumImprovement, "minimumImprovement", 0);
  if (!Array.isArray(p.objective.range) || p.objective.range.length !== 2)
    fail("invalid_policy", "Metric range required.");
  p.objective.range.forEach((v) => finite(v, "range"));
  if (p.objective.range[1] <= p.objective.range[0])
    fail("invalid_policy", "Range must increase.");
  finite(p.objective.alpha, "alpha");
  if (p.objective.alpha <= 0 || p.objective.alpha >= 1)
    fail("invalid_policy", "alpha must be between 0 and 1.");
  if (p.objective.acceptance !== undefined)
    enumeration(p.objective.acceptance, ["confidence"], "acceptance");
  if (p.objective.minimumEffect !== undefined)
    finite(p.objective.minimumEffect, "minimumEffect");
  if (p.objective.confidence !== undefined) {
    finite(p.objective.confidence, "confidence");
    if (p.objective.confidence <= 0 || p.objective.confidence >= 1)
      fail("invalid_policy", "confidence must be between 0 and 1.");
  }
  if (p.objective.bootstrapSamples !== undefined) {
    integer(p.objective.bootstrapSamples, "bootstrapSamples", 100);
    if (p.objective.bootstrapSamples > MAX_BOOTSTRAP_SAMPLES)
      fail(
        "invalid_policy",
        `bootstrapSamples cannot exceed ${MAX_BOOTSTRAP_SAMPLES}.`,
      );
  }
  if (p.objective.bootstrapSeed !== undefined) {
    finite(p.objective.bootstrapSeed, "bootstrapSeed");
    if (!Number.isSafeInteger(p.objective.bootstrapSeed))
      fail("invalid_policy", "bootstrapSeed must be an integer.");
  }
  if (p.objective.minimumItems !== undefined)
    integer(p.objective.minimumItems, "minimumItems", 0);
  if (p.objective.minimumValidationDecisive !== undefined)
    integer(p.objective.minimumValidationDecisive, "minimumValidationDecisive");
  if (p.objective.minimumAuditDecisive !== undefined)
    integer(p.objective.minimumAuditDecisive, "minimumAuditDecisive");
  if (
    p.objective.acceptance !== "confidence" &&
    (p.objective.minimumValidationDecisive !== undefined ||
      p.objective.minimumAuditDecisive !== undefined)
  )
    fail(
      "invalid_policy",
      "Decisive-item minimums require confidence acceptance.",
    );
  if (p.objective.noiseFloor !== undefined) {
    if (p.objective.acceptance !== "confidence")
      fail("invalid_policy", "Noise floor requires confidence acceptance.");
    const setting = p.objective.noiseFloor;
    if (!setting || typeof setting !== "object" || Array.isArray(setting))
      fail("invalid_policy", "noiseFloor must name the validation and audit splits.");
    fields(setting, ["validation", "audit"]);
    for (const key of ["validation", "audit"] as const) {
      if (setting[key] !== undefined && typeof setting[key] !== "boolean")
        fail("invalid_policy", `noiseFloor.${key} must be a boolean.`);
    }
  }
  if (p.objective.retention !== undefined) {
    if (p.objective.acceptance !== "confidence")
      fail("invalid_policy", "Retention requires confidence acceptance.");
    const setting = p.objective.retention;
    if (!setting || typeof setting !== "object" || Array.isArray(setting))
      fail("invalid_policy", "retention must set a margin.");
    fields(setting, ["margin", "confidence"]);
    if (!Object.hasOwn(setting, "margin"))
      fail("invalid_policy", "retention must set a margin.");
    finite(setting.margin, "retention margin", 0);
    if (setting.confidence !== undefined) {
      finite(setting.confidence, "retention confidence");
      if (setting.confidence <= 0 || setting.confidence >= 1)
        fail("invalid_policy", "retention confidence must be between 0 and 1.");
    }
  }
  gates(p.guardrails);
  gates(p.observation?.guardrails);
  if (!Array.isArray(p.trustedSources) || !p.trustedSources.length)
    fail("invalid_policy", "Trusted feedback sources required.");
  p.trustedSources.forEach((s) => nonempty(s, "source"));
  for (const key of [
    "minimumNewUnits",
    "minimumValidationUnits",
    "minimumAuditUnits",
    "maximumRows",
  ] as const)
    integer(p[key], key);
  for (const key of ["outcomeMaturityMs", "cooldownMs"] as const)
    integer(p[key], key, 0);
  fields(p.daily, ["modelRequests", "tokens", "deployments"]);
  fields(p.callbackReservation, ["modelRequests", "tokens"]);
  for (const key of ["modelRequests", "tokens", "deployments"] as const)
    integer(p.daily[key], key, 0);
  for (const key of ["modelRequests", "tokens"] as const)
    integer(p.callbackReservation[key], key, 0);
  if (p.daily.deployments < 1)
    fail("invalid_policy", "A finite positive deployment ceiling is required.");
  if (p.caps !== undefined) validateCaps(p.caps);
  fields(p.rollout, ["mode"]);
  enumeration(p.rollout.mode, ["immediate", "canary"], "rollout mode");
  fields(p.observation, [
    "minimumDurationMs",
    "timeoutMs",
    "minimumUnits",
    "guardrails",
    "onTimeout",
    "onFailure",
  ]);
  integer(p.observation.minimumDurationMs, "minimumDurationMs", 0);
  integer(p.observation.timeoutMs, "timeoutMs");
  integer(p.observation.minimumUnits, "minimumUnits");
  if (p.observation.timeoutMs <= p.observation.minimumDurationMs)
    fail("invalid_policy", "Observation timeout must exceed minimum duration.");
  if (
    p.observation.onTimeout !== "rollback" ||
    p.observation.onFailure !== "rollback" ||
    p.onInsufficientEvidence !== "wait" ||
    p.onUncertainDeployment !== "reconcile"
  )
    fail("invalid_policy", "Unsupported unsafe fallback.");
  integer(p.maximumCandidates ?? 3, "maximumCandidates");
  integer(p.maximumProposalCalls ?? 3, "maximumProposalCalls");
  integer(p.maximumConsecutiveFailures ?? 3, "maximumConsecutiveFailures");
  if (p.auditMethod) {
    fields(p.auditMethod, ["name", "version"]);
    nonempty(p.auditMethod.name, "audit method");
    nonempty(p.auditMethod.version, "audit method version");
  }
  if (p.objective.acceptance === "confidence") {
    if (p.rollout.mode !== "immediate")
      fail(
        "invalid_policy",
        "Confidence acceptance requires immediate rollout. Canary observation still uses the fixed margin.",
      );
    if (p.auditMethod)
      fail(
        "invalid_policy",
        "Confidence acceptance does not combine with a custom audit method.",
      );
    const floor = minimumDecisiveFloor(p.objective.confidence ?? 0.9);
    const validationDecisive = p.objective.minimumValidationDecisive ?? floor;
    const auditDecisive = p.objective.minimumAuditDecisive ?? floor;
    if (validationDecisive < floor)
      fail(
        "invalid_policy",
        "minimumValidationDecisive is below the confidence decisive floor.",
      );
    if (auditDecisive < floor)
      fail(
        "invalid_policy",
        "minimumAuditDecisive is below the confidence decisive floor.",
      );
    if (p.minimumValidationUnits < floor || p.minimumAuditUnits < floor)
      fail(
        "invalid_policy",
        `Confidence acceptance needs at least ${floor} validation units and ${floor} audit units.`,
      );
    if (p.minimumValidationUnits < validationDecisive)
      fail(
        "invalid_policy",
        "minimumValidationDecisive cannot exceed minimumValidationUnits.",
      );
    if (p.minimumAuditUnits < auditDecisive)
      fail(
        "invalid_policy",
        "minimumAuditDecisive cannot exceed minimumAuditUnits.",
      );
  }
}

/**
 * Retention check for a candidate that has already passed audit.
 * Omitted policy returns `not_measured` and does not read the ledger.
 * The decisive floor follows the audit check, and a higher retention
 * confidence can only raise that floor.
 */
export function promotionRetention(
  policy: AutonomyPolicy,
  cases: readonly { id: string; candidate: number }[],
  bestEver: BestEverRecord | null,
): RetentionDecision {
  const setting = policy.objective.retention;
  if (!setting) return notMeasuredRetention();
  const confidence = setting.confidence ?? policy.objective.confidence ?? 0.9;
  const floor = minimumDecisiveFloor(confidence);
  const auditFloor = minimumDecisiveFloor(policy.objective.confidence ?? 0.9);
  const configured = policy.objective.minimumAuditDecisive ?? Math.max(floor, auditFloor);
  return decideRetention({
    enabled: true,
    candidateItems: cases.map((row) => ({ id: row.id, score: row.candidate })),
    bestEver,
    margin: setting.margin,
    direction: policy.objective.direction,
    parameters: gateParameters({
      confidence,
      ...(policy.objective.bootstrapSamples !== undefined
        ? { samples: policy.objective.bootstrapSamples }
        : {}),
      ...(policy.objective.bootstrapSeed !== undefined
        ? { seed: policy.objective.bootstrapSeed }
        : {}),
      minimumDecisive: Math.max(floor, configured),
    }),
  });
}

/** True when this split re-scores the incumbent. Omitted or false leaves the check off. */
export function noiseFloorEnabled(
  objective: AutonomyPolicy["objective"],
  audit: boolean,
): boolean {
  const setting = objective.noiseFloor;
  if (!setting) return false;
  return audit ? setting.audit === true : setting.validation === true;
}

export function confidenceDecisiveMinimum(
  objective: AutonomyPolicy["objective"],
  audit: boolean,
): number {
  const floor = minimumDecisiveFloor(objective.confidence ?? 0.9);
  const configured = audit
    ? objective.minimumAuditDecisive
    : objective.minimumValidationDecisive;
  return configured ?? floor;
}
/** Reject leakage; quarantine conflicting corrections and deduplicate episodes before scoring. */
export function prepareDataset(
  raw: DatasetSnapshot,
  p: AutonomyPolicy,
  now: string,
): DatasetSnapshot {
  json(raw, 16 * 1024 * 1024);
  fields(raw, ["version", "optimization", "validation", "audit"]);
  nonempty(raw.version, "dataset version");
  const partitions: DatasetRow[][] = [];
  const seenIds = new Set<string>(),
    seenEpisodes = new Set<string>(),
    seenEntities = new Set<string>();
  let lastTime = -Infinity;
  for (const name of ["optimization", "validation", "audit"] as const) {
    const rows = raw[name];
    if (!Array.isArray(rows) || rows.length > p.maximumRows)
      fail("query_limit", "Invalid or oversized dataset partition.");
    const grouped = new Map<string, DatasetRow[]>(),
      localIds = new Map<string, string>();
    for (const r of rows) {
      fields(r, [
        "id",
        "episodeId",
        "entityId",
        "occurredAt",
        "observedAt",
        "source",
        "input",
        "label",
      ]);
      for (const key of ["id", "episodeId", "entityId", "source"] as const)
        nonempty(r[key], key);
      if (!Object.hasOwn(r, "input") || !Object.hasOwn(r, "label"))
        fail("invalid_input", "Missing dataset input/label.");
      timestamp(r.occurredAt, "occurredAt");
      timestamp(r.observedAt, "observedAt");
      if (Date.parse(r.observedAt) < Date.parse(r.occurredAt))
        fail("invalid_input", "Outcome predates execution.");
      if (
        seenIds.has(r.id) ||
        seenEpisodes.has(r.episodeId) ||
        seenEntities.has(r.entityId)
      )
        fail("dataset_leakage", "Dataset partitions overlap.");
      if (localIds.has(r.id) && localIds.get(r.id) !== hash(r))
        fail(
          "conflicting_correction",
          "Duplicate row ID with conflicting content.",
        );
      localIds.set(r.id, hash(r));
      if (
        !p.trustedSources.includes(r.source) ||
        Date.parse(r.observedAt) + p.outcomeMaturityMs > Date.parse(now)
      )
        continue;
      const list = grouped.get(r.episodeId) ?? [];
      list.push(r);
      grouped.set(r.episodeId, list);
    }
    const eligible: DatasetRow[] = [],
      entityUnits = new Set<string>();
    for (const episode of [...grouped.keys()].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )) {
      const group = grouped.get(episode)!;
      if (new Set(group.map((r) => hash(r.label))).size !== 1) continue;
      const r = [...group].sort((a, b) =>
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      )[0]!;
      if (new Set(group.map((r) => r.entityId)).size !== 1)
        fail("invalid_input", "An episode must belong to one entity.");
      // Conservative independence: a repeated entity cannot inflate the sample count.
      if (entityUnits.has(r.entityId)) continue;
      entityUnits.add(r.entityId);
      if (Date.parse(r.occurredAt) <= lastTime)
        fail("dataset_leakage", "Partitions must be strictly time separated.");
      eligible.push(r);
    }
    for (const r of rows) {
      seenIds.add(r.id);
      seenEpisodes.add(r.episodeId);
      seenEntities.add(r.entityId);
    }
    if (eligible.length)
      lastTime = Math.max(...eligible.map((r) => Date.parse(r.occurredAt)));
    partitions.push(
      eligible.sort((a, b) =>
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      ),
    );
  }
  return {
    version: raw.version,
    optimization: partitions[0]!,
    validation: partitions[1]!,
    audit: partitions[2]!,
  };
}
export function passesGates(
  metrics: Record<string, number>,
  rules: MetricGate[],
): boolean {
  object(metrics, "metrics");
  Object.values(metrics).forEach((v) => finite(v, "metric"));
  return rules.every(
    (g) =>
      Object.hasOwn(metrics, g.metric) &&
      (g.comparator === "gte"
        ? metrics[g.metric]! >= g.value
        : metrics[g.metric]! <= g.value),
  );
}
const acceptanceCache = new Map<string, GateDecision>();

function cachedAcceptance(
  items: { id: string; incumbent: number; candidate: number }[],
  direction: "maximize" | "minimize",
  parameters: ReturnType<typeof gateParameters>,
): GateDecision {
  const key = hash({ items, direction, parameters });
  const hit = acceptanceCache.get(key);
  if (hit) return hit;
  const decision = decideAcceptance({ items, direction, parameters });
  if (acceptanceCache.size > 32) acceptanceCache.clear();
  acceptanceCache.set(key, decision);
  return decision;
}

export interface PointEstimateMargin {
  minimumImprovement: number;
  effect: number;
  passed: boolean;
  outcome: "passed" | "below_margin";
}

/**
 * Immediate confidence acceptance checks `minimumImprovement` against the
 * paired point estimate. The interval lower bound is a separate rule.
 * Canary observation keeps its own lower-bound check, so this returns null there.
 */
export function pointEstimateMargin(
  policy: AutonomyPolicy,
  effect: number,
): PointEstimateMargin | null {
  if (policy.objective.acceptance !== "confidence") return null;
  if ((policy.rollout?.mode ?? "immediate") !== "immediate") return null;
  const minimumImprovement = policy.objective.minimumImprovement;
  const passed = effect >= minimumImprovement;
  return {
    minimumImprovement,
    effect,
    passed,
    outcome: passed ? "passed" : "below_margin",
  };
}

export function compare(
  result: Comparison,
  rows: DatasetRow[],
  p: AutonomyPolicy,
  audit = false,
) {
  json(result, 16 * 1024 * 1024);
  fields(result, ["cases", "metrics", "estimatedServingCost", "uncertainty"]);
  finite(result.estimatedServingCost, "serving cost", 0);
  if (
    !Array.isArray(result.cases) ||
    result.cases.length !== rows.length ||
    new Set(result.cases.map((r) => r.id)).size !== rows.length
  )
    fail(
      "invalid_evaluation",
      "One result per independent dataset unit required.",
    );
  const ids = new Set(rows.map((r) => r.id)),
    [lo, hi] = p.objective.range;
  let a = 0,
    b = 0;
  const measureNoise =
    p.objective.acceptance === "confidence" && !(audit && p.auditMethod) && noiseFloorEnabled(p.objective, audit);
  for (const r of result.cases) {
    fields(r, ["id", "baseline", "candidate", "baselineRepeat"]);
    if (!ids.has(r.id)) fail("invalid_evaluation", "Unrecognized case.");
    const scores = [r.baseline, r.candidate];
    if (r.baselineRepeat !== undefined) scores.push(r.baselineRepeat);
    else if (measureNoise)
      fail("invalid_evaluation", "Noise floor needs a second incumbent score on every item.");
    for (const v of scores) {
      finite(v, "case", lo);
      if (v > hi) fail("invalid_evaluation", "Score outside declared range.");
    }
    a += r.baseline;
    b += r.candidate;
  }
  const n = rows.length,
    improvement = n
      ? ((b - a) / n) * (p.objective.direction === "maximize" ? 1 : -1)
      : 0;
  // Paired differences lie in [-(hi-lo), hi-lo]; fixed-sample one-sided Hoeffding bound.
  let lower = n
    ? improvement -
      (hi - lo) * Math.sqrt((2 * Math.log(1 / p.objective.alpha)) / n)
    : -Infinity;
  const confidence =
    p.objective.acceptance === "confidence" && !(audit && p.auditMethod)
        ? cachedAcceptance(
          result.cases.map((row) => ({
            id: row.id,
            incumbent: row.baseline,
            candidate: row.candidate,
            ...(measureNoise ? { incumbentRepeat: row.baselineRepeat } : {}),
          })),
          p.objective.direction,
          gateParameters({
            ...(p.objective.minimumEffect !== undefined
              ? { minimumEffect: p.objective.minimumEffect }
              : {}),
            ...(p.objective.confidence !== undefined
              ? { confidence: p.objective.confidence }
              : {}),
            ...(p.objective.bootstrapSamples !== undefined
              ? { samples: p.objective.bootstrapSamples }
              : {}),
            ...(p.objective.bootstrapSeed !== undefined
              ? { seed: p.objective.bootstrapSeed }
              : {}),
            ...(p.objective.minimumItems !== undefined
              ? { minimumItems: p.objective.minimumItems }
              : {}),
            minimumDecisive: confidenceDecisiveMinimum(p.objective, audit),
          }),
        )
      : undefined;
  if (audit && p.auditMethod) {
    const u = result.uncertainty;
    fields(u, ["method", "version", "lowerBound", "assumptionsValid"]);
    finite(u.lowerBound, "custom lower bound");
    if (
      u.method !== p.auditMethod.name ||
      u.version !== p.auditMethod.version ||
      u.assumptionsValid !== true
    )
      fail(
        "invalid_evaluation",
        "Custom audit method identity/assumptions not satisfied.",
      );
    if (u.lowerBound > improvement || u.lowerBound < -(hi - lo))
      fail(
        "invalid_evaluation",
        "Custom lower bound is inconsistent with the bounded observed effect.",
      );
    lower = u.lowerBound;
  }
  const margin = confidence ? pointEstimateMargin(p, improvement) : null;
  // The interval rule is unchanged. Immediate confidence also requires the
  // point estimate to meet minimumImprovement. Canary does not use this check.
  const marginBlocked = Boolean(margin && confidence?.accept && !margin.passed);
  const marginPassed = confidence
    ? confidence.accept && !marginBlocked
    : (audit ? lower : improvement) > p.objective.minimumImprovement;
  const passed =
    n > 0 &&
    n >= (audit ? p.minimumAuditUnits : p.minimumValidationUnits) &&
    passesGates(result.metrics, p.guardrails) &&
    marginPassed;
  const reportedLower = confidence ? confidence.lower : Number.isFinite(lower) ? lower : null;
  return {
    passed,
    outcome: confidence
      ? marginBlocked
        ? "rejected"
        : confidence.outcome
      : passed
        ? "accepted"
        : "rejected",
    margin,
    marginBlocked,
    baseline: n ? a / n : 0,
    candidate: n ? b / n : 0,
    improvement,
    lower: reportedLower,
    upper: confidence ? confidence.upper : null,
    sampleCount: n,
    decisive: confidence ? confidence.decisive : null,
    required: confidence ? confidence.required : null,
    noiseFloor: confidence
      ? confidence.noiseFloor
      : { value: null, method: "not_measured" as const, items: null, calls: null },
    effectiveThreshold: confidence ? confidence.effectiveThreshold : null,
    bindingThreshold: confidence ? confidence.bindingThreshold : null,
  };
}

/**
 * Smallest fixed audit whose paired Hoeffding lower bound can exceed
 * `minimumImprovement` for `gain`. Omit `gain` to use the full score range,
 * which is the largest effect this bound can ever see. A smaller audit cannot
 * certify that gain at the configured alpha, even when every unit improves.
 */
export function minimumCertifiableAuditUnits(
  objective: {
    minimumImprovement: number;
    range: readonly [number, number];
    alpha: number;
  },
  gain?: number,
): number {
  const [lo, hi] = objective.range;
  const width = hi - lo;
  finite(objective.minimumImprovement, "minimumImprovement", 0);
  finite(objective.alpha, "alpha");
  if (!(width > 0) || !(objective.alpha > 0 && objective.alpha < 1))
    fail("invalid_policy", "Cannot size an audit for this objective.");
  const effect = gain ?? width;
  finite(effect, "gain", 0);
  if (effect > width)
    fail("invalid_policy", "Gain cannot exceed the declared score range.");
  if (effect <= objective.minimumImprovement)
    fail(
      "invalid_policy",
      "No audit size can certify a gain that does not exceed the minimum improvement.",
    );
  const gap = (effect - objective.minimumImprovement) / width;
  let n =
    Math.floor(
      (2 * Math.log(1 / objective.alpha)) / (gap * gap) + 1e-9,
    ) + 1;
  const clears = (size: number) =>
    effect -
      width * Math.sqrt((2 * Math.log(1 / objective.alpha)) / size) >
    objective.minimumImprovement;
  while (!clears(n)) {
    n += 1;
    if (n > 100_000_000)
      fail("invalid_policy", "Audit size needed to certify this gain is not usable.");
  }
  return n;
}

/** `minimumImprovement` is the bound a gain must clear. The no-gain size is the full-range floor, not that gain. */
export function describeAuditFloor(objective: {
  minimumImprovement: number;
  range: readonly [number, number];
  alpha: number;
}): string {
  const floor = minimumCertifiableAuditUnits(objective);
  const samples = [0.05, 0.1, 0.2].map((gain) => {
    const label = gain.toFixed(2);
    try {
      const units = minimumCertifiableAuditUnits(objective, gain);
      return `a gain of ${label} needs ${units} units`;
    } catch {
      return `a gain of ${label} does not exceed the minimum improvement, so no sample size can certify it`;
    }
  });
  return `minimumImprovement ${objective.minimumImprovement} is the lower bound a certified gain must clear, not a gain ${floor} units can certify. At least ${floor} units are required before even a full-range effect can pass. At alpha ${objective.alpha}, ${samples.join("; ")}.`;
}
