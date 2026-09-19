import type {
  AutonomyPolicy,
  ChangeSchema,
  Comparison,
  DatasetRow,
  DatasetSnapshot,
  MetricGate,
} from "./improvement-contracts.js";
import type { JsonValue } from "./contracts.js";
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
  enumeration(p.target.kind, ["prompt", "routing"], "autonomous target");
  validateSchema(p.changeSchema);
  fields(p.objective, [
    "metric",
    "direction",
    "minimumImprovement",
    "range",
    "alpha",
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
  for (const r of result.cases) {
    fields(r, ["id", "baseline", "candidate"]);
    if (!ids.has(r.id)) fail("invalid_evaluation", "Unrecognized case.");
    for (const v of [r.baseline, r.candidate]) {
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
  const passed =
    n > 0 &&
    n >= (audit ? p.minimumAuditUnits : p.minimumValidationUnits) &&
    passesGates(result.metrics, p.guardrails) &&
    (audit ? lower : improvement) > p.objective.minimumImprovement;
  return {
    passed,
    baseline: n ? a / n : 0,
    candidate: n ? b / n : 0,
    improvement,
    lower: Number.isFinite(lower) ? lower : null,
    sampleCount: n,
  };
}
