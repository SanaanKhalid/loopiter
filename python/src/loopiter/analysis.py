"""Descriptive structured segments, not causal inference or a probability of improvement."""

from collections import defaultdict
from copy import deepcopy
from datetime import timedelta
from itertools import combinations
from typing import TYPE_CHECKING, Any

from . import _validation as v

if TYPE_CHECKING:
    from .client import FeedbackLoop


def default_signal_score(signal: v.Record) -> float | None:
    value = signal["value"]
    if type(value) is bool:
        return float(value)
    if type(value) in (int, float):
        return value
    if type(value) is str:
        if value.lower() in ("yes", "good", "correct", "positive", "success"):
            return 1
        if value.lower() in ("no", "bad", "incorrect", "negative", "failure"):
            return 0
    return None


async def _read_all(loop, tx, kind, maximum, window):
    rows, cursor = [], None
    while True:
        limit = min(1000, maximum + 1 - len(rows))
        page = loop._page(
            kind, await tx.list(kind, limit=limit, cursor=cursor, window=window), limit, cursor
        )
        for row in page["items"]:
            when = row["observed_at"] if kind == "signals" else row["started_at"]
            if not v.in_window(when, window):
                v.fail("integrity_error", "Adapter ignored the query window.")
        rows.extend(page["items"])
        if len(rows) > maximum:
            v.fail(
                "query_limit",
                f"Analysis exceeds {maximum} {kind}; narrow the window or increase maximum_records.",
            )
        cursor = page.get("next_cursor")
        if cursor is None:
            return rows


def _summary(units):
    total, weight = 0.0, 0.0
    for values in units.values():
        w = sum(item[0]["confidence"] for item in values.values())
        weighted = sum(item[0]["confidence"] * item[1] for item in values.values())
        unit_weight = w / len(values)
        total += weighted / w * unit_weight
        weight += unit_weight
    if not weight:
        return None
    mean = total / weight
    v.finite(mean, "aggregated mean")
    v.finite(weight, "effective weight")
    return {"mean": mean, "weight": weight, "count": len(units)}


def _bucket(time, size):
    if size == "day":
        return time[:10]
    if size == "month":
        return time[:7]
    day = v.timestamp(time)
    return (day - timedelta(days=day.weekday())).date().isoformat()


def _unit(row):
    return "episode:" + row["episode_id"] if row.get("episode_id") else "execution:" + row["id"]


async def analyze(
    loop: "FeedbackLoop",
    *,
    dimensions: list[str],
    maximum_dimension_depth: int = 2,
    execution_kinds: list[str] | None = None,
    signal_kinds: list[str] | None = None,
    signal_names: list[str] | None = None,
    execution_window: v.Record | None = None,
    observation_window: v.Record | None = None,
    minimum_support: int = 5,
    minimum_scored_count: int = 2,
    minimum_effect_size: float = 0,
    minimum_recurrence: int = 1,
    minimum_distinct_entities: int = 0,
    time_bucket: str = "week",
    include_episode_signals: bool = True,
    maximum_records: int = 20000,
    score=None,
    scoring_version: str = "default-v1",
) -> list[v.Record]:
    if type(dimensions) is not list or not 1 <= len(dimensions) <= 8:
        v.fail("invalid_input", "Choose 1–8 dimensions.")
    for d in dimensions:
        v.nonempty(d, "dimension")
    if len(set(dimensions)) != len(dimensions):
        v.fail("invalid_input", "Duplicate dimensions.")
    for name, items, allowed in (
        ("execution_kinds", execution_kinds, v.EXECUTION_KINDS),
        ("signal_kinds", signal_kinds, v.SIGNAL_KINDS),
        ("signal_names", signal_names, None),
    ):
        if items is not None:
            if type(items) is not list:
                v.fail("invalid_input", f"{name} must be a list.")
            for item in items:
                v.nonempty(item, name)
                if allowed is not None:
                    v.enum(item, allowed, name)
    execution_window = {} if execution_window is None else execution_window
    observation_window = {} if observation_window is None else observation_window
    v.window_valid(execution_window)
    v.window_valid(observation_window)
    for name, number in (
        ("maximum_records", maximum_records),
        ("maximum_dimension_depth", maximum_dimension_depth),
        ("minimum_support", minimum_support),
        ("minimum_scored_count", minimum_scored_count),
        ("minimum_recurrence", minimum_recurrence),
    ):
        v.integer(number, name)
    if maximum_dimension_depth > 2:
        v.fail("query_limit", "Alpha supports dimension depth 1 or 2.")
    v.integer(minimum_distinct_entities, "minimum_distinct_entities", 0)
    v.finite(minimum_effect_size, "minimum_effect_size", 0)
    v.enum(time_bucket, ["day", "week", "month"], "time_bucket")
    if type(include_episode_signals) is not bool:
        v.fail("invalid_input", "include_episode_signals must be boolean.")
    v.nonempty(scoring_version, "scoring_version")
    if score is not None and not callable(score):
        v.fail("invalid_input", "score must be a synchronous callable.")
    async with loop.store.transaction(loop.namespace) as tx:
        executions = await _read_all(loop, tx, "executions", maximum_records, execution_window)
        signals = await _read_all(loop, tx, "signals", maximum_records, observation_window)
    selected = [e for e in executions if execution_kinds is None or e["kind"] in execution_kinds]
    by_execution, by_episode = defaultdict(list), defaultdict(list)
    for signal in signals:
        if signal_names is not None and signal["name"] not in signal_names:
            continue
        if signal_kinds is not None and signal["kind"] not in signal_kinds:
            continue
        value = (score or default_signal_score)(deepcopy(signal))
        if value is not None:
            v.finite(value, "score callback result")
        if value is None or signal["confidence"] <= 0:
            continue
        index = by_execution if signal.get("execution_id") else by_episode
        index[signal.get("execution_id", signal.get("episode_id"))].append((signal, value))

    def units_for(rows):
        units = defaultdict(dict)
        for row in rows:
            items = [*by_execution[row["id"]]]
            if include_episode_signals and row.get("episode_id"):
                items.extend(by_episode[row["episode_id"]])
            for item in items:
                units[_unit(row)][item[0]["id"]] = item
        return units

    baseline_units = units_for(selected)
    baseline = _summary(baseline_units)
    if baseline is None:
        return []
    sets = [(d,) for d in dimensions]
    if maximum_dimension_depth == 2:
        sets.extend(combinations(dimensions, 2))
    segments: dict[str, Any] = {}
    missing = object()
    for row in selected:
        for subset in sets:
            values = {}
            for path in subset:
                value: Any = row
                for component in path.split("."):
                    value = value.get(component, missing) if type(value) is dict else missing
                if value is missing:
                    break
                values[path] = value
            if len(values) == len(subset):
                segments.setdefault(v.canonical(values), (values, []))[1].append(row)
    baseline_fingerprint = v.fingerprint(
        {
            "executions": sorted([r["id"], r["revision"], r["input_hash"]] for r in selected),
            "units": sorted(
                [
                    key,
                    sorted(
                        [s["id"], s["input_hash"], val, s["confidence"]]
                        for s, val in items.values()
                    ),
                ]
                for key, items in baseline_units.items()
            ),
            "scoring_version": scoring_version,
        }
    )
    findings = []
    for values, rows in segments.values():
        units = units_for(rows)
        stats = _summary(units)
        if stats is None or len(units) < minimum_support or stats["count"] < minimum_scored_count:
            continue
        effect = stats["mean"] - baseline["mean"]
        v.finite(effect, "effect size")
        if abs(effect) < minimum_effect_size:
            continue
        unique, corrections = {}, defaultdict(int)
        for items in units.values():
            unit_corrections = set()
            for key, item in items.items():
                unique[key] = item
                if "correction" in item[0]:
                    unit_corrections.add(v.canonical(item[0]["correction"]))
            for correction in unit_corrections:
                corrections[correction] += 1
        buckets = {_bucket(item[0]["observed_at"], time_bucket) for item in unique.values()}
        eligible = [r for r in rows if _unit(r) in units]
        entities = {r["entity_id"] for r in eligible if r.get("entity_id")}
        if len(buckets) < minimum_recurrence or len(entities) < minimum_distinct_entities:
            continue
        manifest = {
            "version": 1,
            "execution_ids": sorted(r["id"] for r in eligible),
            "signal_ids": sorted(unique),
            "execution_window": execution_window,
            "observation_window": observation_window,
            "scoring_version": scoring_version,
        }
        manifest["fingerprint"] = v.fingerprint(
            {"manifest": manifest, "baseline": baseline_fingerprint}
        )
        findings.append(
            {
                "id": v.fingerprint({"namespace": loop.namespace, "dimensions": values}),
                "namespace": loop.namespace,
                "dimensions": values,
                "support": len(units),
                "execution_count": len(rows),
                "unique_signal_count": len(unique),
                "episode_count": len({r["episode_id"] for r in eligible if r.get("episode_id")}),
                "scored_count": stats["count"],
                "effective_weight": stats["weight"],
                "mean_score": stats["mean"],
                "baseline_score": baseline["mean"],
                "effect_size": effect,
                "recurrence": len(buckets),
                "distinct_entities": len(entities),
                "correction_counts": dict(corrections),
                "evidence": manifest,
            }
        )
    return sorted(findings, key=lambda f: (f["effect_size"], f["id"]))
