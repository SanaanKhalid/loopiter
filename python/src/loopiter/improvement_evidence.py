"""Dependency-free bounded schemas, independent units and fixed-sample audit gates.

Scores are a single explicitly directed objective, not an average of unrelated metrics.
The paired Hoeffding bound assumes independent bounded units and a frozen audit set.
"""

import math
from copy import deepcopy

from . import _validation as v


def validate_schema(schema):
    v.fields(
        schema,
        [
            "type",
            "properties",
            "required",
            "additionalProperties",
            "enum",
            "minimum",
            "maximum",
            "maxLength",
        ],
    )
    v.enum(schema.get("type"), ["object", "string", "number", "boolean"], "schema type")
    if "enum" in schema and (type(schema["enum"]) is not list or not schema["enum"]):
        v.fail("invalid_policy", "Empty enum.")
    if schema["type"] == "object":
        v.obj(schema.get("properties"), "schema properties")
        if (
            schema.get("additionalProperties") is not False
            or type(schema.get("required")) is not list
        ):
            v.fail(
                "invalid_policy", "Objects require explicit fields and additionalProperties:false."
            )
        if any(key not in schema["properties"] for key in schema["required"]):
            v.fail("invalid_policy", "Unknown required field.")
        for child in schema["properties"].values():
            validate_schema(child)
    for name in ("minimum", "maximum"):
        if name in schema:
            v.finite(schema[name], name)
    if schema.get("minimum", -math.inf) > schema.get("maximum", math.inf):
        v.fail("invalid_policy", "Reversed bounds.")
    if "maxLength" in schema:
        v.integer(schema["maxLength"], "maxLength")
    if schema["type"] == "string" and "enum" not in schema and "maxLength" not in schema:
        v.fail("invalid_policy", "Prompt fragments require an explicit length bound.")
    if (
        schema["type"] == "number"
        and "enum" not in schema
        and not {"minimum", "maximum"} <= set(schema)
    ):
        v.fail("invalid_policy", "Numeric changes require explicit bounds.")


def validate_change(value, schema):
    v.json_value(value)
    if "enum" in schema and not any(
        v.fingerprint(value) == v.fingerprint(x) for x in schema["enum"]
    ):
        v.fail("forbidden_change", "Value outside enum.")
    kind = schema["type"]
    if kind == "object":
        v.obj(value, "change")
        if set(schema["required"]) - set(value) or set(value) - set(schema["properties"]):
            v.fail("forbidden_change", "Unknown or missing change fields.")
        for name, child in value.items():
            validate_change(child, schema["properties"][name])
    elif kind == "number":
        v.finite(value, "change")
        if not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            v.fail("forbidden_change", "Change outside bounds.")
    elif type(value) is not {"string": str, "boolean": bool}[kind]:
        v.fail("forbidden_change", "Change type mismatch.")
    if type(value) is str and len(value) > schema.get("maxLength", math.inf):
        v.fail("forbidden_change", "String limit exceeded.")


def _gates(rules):
    if type(rules) is not list or not rules:
        v.fail("invalid_policy", "Independent guardrails required.")
    for gate in rules:
        v.fields(gate, ["metric", "comparator", "value"], ("metric", "comparator", "value"))
        v.nonempty(gate["metric"], "metric")
        v.enum(gate["comparator"], ["gte", "lte"], "comparator")
        v.finite(gate["value"], "gate")


def validate_policy(p):
    v.json_value(p)
    names = (
        "version target change_schema objective guardrails trusted_sources minimum_new_units "
        "minimum_validation_units minimum_audit_units outcome_maturity_ms maximum_rows daily "
        "callback_reservation cooldown_ms rollout observation on_insufficient_evidence "
        "on_uncertain_deployment"
    ).split()
    v.fields(
        p,
        names
        + [
            "maximum_candidates",
            "maximum_proposal_calls",
            "maximum_consecutive_failures",
            "audit_method",
        ],
        tuple(names),
    )
    v.nonempty(p["version"], "policy version")
    v.target(p["target"])
    v.enum(p["target"]["kind"], ["prompt", "routing"], "autonomous target")
    validate_schema(p["change_schema"])
    o = p["objective"]
    v.fields(
        o,
        ["metric", "direction", "minimum_improvement", "range", "alpha"],
        ("metric", "direction", "minimum_improvement", "range", "alpha"),
    )
    v.nonempty(o["metric"], "objective")
    v.enum(o["direction"], ["maximize", "minimize"], "direction")
    v.finite(o["minimum_improvement"], "minimum improvement", 0)
    if type(o["range"]) is not list or len(o["range"]) != 2:
        v.fail("invalid_policy", "Metric range required.")
    for x in o["range"]:
        v.finite(x, "range")
    v.finite(o["alpha"], "alpha")
    if o["range"][1] <= o["range"][0] or not 0 < o["alpha"] < 1:
        v.fail("invalid_policy", "Invalid range/alpha.")
    _gates(p["guardrails"])
    if type(p["trusted_sources"]) is not list or not p["trusted_sources"]:
        v.fail("invalid_policy", "Trusted sources required.")
    for source in p["trusted_sources"]:
        v.nonempty(source, "source")
    for key in (
        "minimum_new_units",
        "minimum_validation_units",
        "minimum_audit_units",
        "maximum_rows",
    ):
        v.integer(p[key], key)
    for key in ("outcome_maturity_ms", "cooldown_ms"):
        v.integer(p[key], key, 0)
    for name, keys in [
        ("daily", ["model_requests", "tokens", "deployments"]),
        ("callback_reservation", ["model_requests", "tokens"]),
    ]:
        v.fields(p[name], keys, tuple(keys))
        for key in keys:
            v.integer(p[name][key], key, 0)
    if p["daily"]["deployments"] < 1:
        v.fail("invalid_policy", "A positive deployment ceiling is required.")
    v.fields(p["rollout"], ["mode"], ("mode",))
    v.enum(p["rollout"]["mode"], ["immediate", "canary"], "rollout mode")
    obs = p["observation"]
    v.fields(
        obs,
        [
            "minimum_duration_ms",
            "timeout_ms",
            "minimum_units",
            "guardrails",
            "on_timeout",
            "on_failure",
        ],
        (
            "minimum_duration_ms",
            "timeout_ms",
            "minimum_units",
            "guardrails",
            "on_timeout",
            "on_failure",
        ),
    )
    v.integer(obs["minimum_duration_ms"], "minimum duration", 0)
    v.integer(obs["timeout_ms"], "timeout")
    v.integer(obs["minimum_units"], "minimum units")
    _gates(obs["guardrails"])
    if obs["timeout_ms"] <= obs["minimum_duration_ms"]:
        v.fail("invalid_policy", "Observation timeout must exceed minimum duration.")
    if (
        obs["on_timeout"],
        obs["on_failure"],
        p["on_insufficient_evidence"],
        p["on_uncertain_deployment"],
    ) != ("rollback", "rollback", "wait", "reconcile"):
        v.fail("invalid_policy", "Unsupported unsafe fallback.")
    for key in ("maximum_candidates", "maximum_proposal_calls", "maximum_consecutive_failures"):
        v.integer(p.get(key, 3), key)
    if "audit_method" in p:
        v.fields(p["audit_method"], ["name", "version"], ("name", "version"))
        v.nonempty(p["audit_method"]["name"], "audit method")
        v.nonempty(p["audit_method"]["version"], "audit method version")


def prepare_dataset(raw, policy, now):
    v.json_value(raw, 16 * 1024 * 1024)
    v.fields(
        raw,
        ["version", "optimization", "validation", "audit"],
        ("version", "optimization", "validation", "audit"),
    )
    v.nonempty(raw["version"], "dataset version")
    result = {"version": raw["version"]}
    ids, episodes, entities = set(), set(), set()
    last_time = -math.inf
    now_ms = v.timestamp(now).timestamp() * 1000
    for name in ("optimization", "validation", "audit"):
        rows = raw[name]
        if type(rows) is not list or len(rows) > policy["maximum_rows"]:
            v.fail("query_limit", "Invalid or oversized dataset partition.")
        grouped, local_ids = {}, {}
        for row in rows:
            names = "id episode_id entity_id occurred_at observed_at source input label".split()
            v.fields(row, names, tuple(names))
            for key in ("id", "episode_id", "entity_id", "source"):
                v.nonempty(row[key], key)
            occurred = v.timestamp(row["occurred_at"]).timestamp() * 1000
            observed = v.timestamp(row["observed_at"]).timestamp() * 1000
            if observed < occurred:
                v.fail("invalid_input", "Outcome predates execution.")
            if row["id"] in ids or row["episode_id"] in episodes or row["entity_id"] in entities:
                v.fail("dataset_leakage", "Dataset partitions overlap.")
            digest = v.fingerprint(row)
            if row["id"] in local_ids and local_ids[row["id"]] != digest:
                v.fail("conflicting_correction", "Duplicate row ID with conflicting content.")
            local_ids[row["id"]] = digest
            if (
                row["source"] not in policy["trusted_sources"]
                or observed + policy["outcome_maturity_ms"] > now_ms
            ):
                continue
            grouped.setdefault(row["episode_id"], []).append(row)
        eligible, entity_units = [], set()
        for episode in sorted(grouped):
            group = grouped[episode]
            if len({v.fingerprint(row["label"]) for row in group}) != 1:
                continue
            row = sorted(group, key=lambda r: r["id"])[0]
            if len({r["entity_id"] for r in group}) != 1:
                v.fail("invalid_input", "An episode must belong to one entity.")
            if row["entity_id"] in entity_units:
                continue
            entity_units.add(row["entity_id"])
            if v.timestamp(row["occurred_at"]).timestamp() <= last_time:
                v.fail("dataset_leakage", "Partitions must be strictly time separated.")
            eligible.append(row)
        ids.update(row["id"] for row in rows)
        episodes.update(row["episode_id"] for row in rows)
        entities.update(row["entity_id"] for row in rows)
        if eligible:
            last_time = max(v.timestamp(row["occurred_at"]).timestamp() for row in eligible)
        result[name] = deepcopy(sorted(eligible, key=lambda r: r["id"]))
    return result


def passes_gates(metrics, rules):
    v.obj(metrics, "metrics")
    for value in metrics.values():
        v.finite(value, "metric")
    return all(
        g["metric"] in metrics
        and (
            metrics[g["metric"]] >= g["value"]
            if g["comparator"] == "gte"
            else metrics[g["metric"]] <= g["value"]
        )
        for g in rules
    )


def compare(result, rows, p, audit=False):
    v.json_value(result, 16 * 1024 * 1024)
    v.fields(
        result,
        ["cases", "metrics", "estimated_serving_cost", "uncertainty"],
        ("cases", "metrics", "estimated_serving_cost"),
    )
    v.finite(result["estimated_serving_cost"], "serving cost", 0)
    cases = result["cases"]
    if type(cases) is not list or len(cases) != len(rows):
        v.fail("invalid_evaluation", "One result per independent dataset unit required.")
    ids, seen, a, b = {r["id"] for r in rows}, set(), 0, 0
    lo, hi = p["objective"]["range"]
    for row in cases:
        v.fields(row, ["id", "baseline", "candidate"], ("id", "baseline", "candidate"))
        if row["id"] not in ids or row["id"] in seen:
            v.fail("invalid_evaluation", "Unrecognized/duplicate case.")
        seen.add(row["id"])
        for value in (row["baseline"], row["candidate"]):
            v.finite(value, "case", lo)
            if value > hi:
                v.fail("invalid_evaluation", "Score outside declared range.")
        a += row["baseline"]
        b += row["candidate"]
    n = len(rows)
    improvement = (b - a) / n * (1 if p["objective"]["direction"] == "maximize" else -1) if n else 0
    lower = (
        improvement - (hi - lo) * math.sqrt(2 * math.log(1 / p["objective"]["alpha"]) / n)
        if n
        else None
    )
    if audit and "audit_method" in p:
        u = result.get("uncertainty")
        v.fields(
            u,
            ["method", "version", "lower_bound", "assumptions_valid"],
            ("method", "version", "lower_bound", "assumptions_valid"),
        )
        v.finite(u["lower_bound"], "custom lower bound")
        if (
            u["method"] != p["audit_method"]["name"]
            or u["version"] != p["audit_method"]["version"]
            or u["assumptions_valid"] is not True
        ):
            v.fail("invalid_evaluation", "Custom audit identity/assumptions not satisfied.")
        if not -(hi - lo) <= u["lower_bound"] <= improvement:
            v.fail("invalid_evaluation", "Custom lower bound inconsistent with observed effect.")
        lower = u["lower_bound"]
    passed = bool(
        n
        and n >= p["minimum_audit_units" if audit else "minimum_validation_units"]
        and passes_gates(result["metrics"], p["guardrails"])
        and (lower if audit else improvement) > p["objective"]["minimum_improvement"]
    )
    return {
        "passed": passed,
        "baseline": a / n if n else 0,
        "candidate": b / n if n else 0,
        "improvement": improvement,
        "lower": lower,
        "sample_count": n,
    }
