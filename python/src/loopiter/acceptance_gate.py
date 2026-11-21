"""Acceptance rule for a candidate versus the incumbent.

The lower bound of a two-sided interval must clear ``minimum_effect``.
That lower bound is the same cutoff as a one-sided bound at
``(1 + confidence) / 2`` (0.95 when confidence is 0.90).
Paired scores use a fixed-seed percentile bootstrap. Items are sorted by id
before resampling, so the bound does not depend on input order.
``minimum_items`` defaults to 0. A percentile interval on one or two items can
accept a one-sided difference. ``minimum_decisive`` counts items whose scores
differ. Below that count the outcome is ``insufficient`` and the interval is
not used. 0 leaves that guard off. Aggregate counts, used only when no paired
items are supplied, use a Newcombe interval built from Wilson bounds.
An optional ``incumbentRepeat`` on every item measures run-to-run jitter.
The same bootstrap, seed, and id order produce an upper bound on the absolute
mean of that pair. The candidate must clear the larger of ``minimum_effect``
and that bound. Omitting the second score records the floor as not measured.
The stream matches the Node gate.
"""

from __future__ import annotations

import math
from typing import Any

MAX_BOOTSTRAP_SAMPLES = 100_000

DEFAULT_GATE = {
    "minimum_effect": 0.0,
    "confidence": 0.9,
    "samples": 2000,
    "seed": 17,
    "minimum_items": 0,
}


def minimum_decisive_floor(confidence: float) -> int:
    """Smallest unanimous decisive count whose one-sided sign-test tail is under the interval tail.

    The two-sided tail is ``(1 - confidence) / 2``. At 0.90 that is 0.05, and
    ``2 ** -5`` is the first power of one half strictly below it, so the floor
    is 5. This is a sign test, not a property of the percentile bootstrap.
    The loop matches the Node gate.
    """
    if not 0 < confidence < 1:
        raise ValueError("Confidence must be between 0 and 1.")
    alpha = (1 - confidence) / 2
    count = 1
    tail = 0.5
    while tail >= alpha:
        count += 1
        tail /= 2
        if count > 64:
            raise ValueError("Decisive floor is not usable at this confidence.")
    return count


_Z_95 = 1.959963984540054
_Z_90 = 1.6448536269514722


def gate_parameters(partial: dict[str, Any] | None = None) -> dict[str, Any]:
    values = dict(DEFAULT_GATE)
    if partial:
        for key in DEFAULT_GATE:
            if key in partial and partial[key] is not None:
                values[key] = partial[key]
        if partial.get("minimum_decisive") is not None:
            values["minimum_decisive"] = partial["minimum_decisive"]
    return values


def decide_acceptance(
    items: list[dict[str, Any]] | None = None,
    unpaired: dict[str, int] | None = None,
    direction: str = "maximize",
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rule = gate_parameters(parameters)
    _validate_parameters(rule)
    sign = 1 if direction == "maximize" else -1
    rows = items or []
    # Paired items take precedence. Unpaired counts are used only when items is empty.
    if rows:
        return _decide_paired(rows, sign, rule)
    if unpaired:
        return _decide_unpaired(unpaired, sign, rule)
    return {
        "accept": False,
        "outcome": "rejected",
        "reason": "empty_sample",
        "lower": None,
        "upper": None,
        "effect": 0.0,
        "method": "paired-bootstrap",
        "item_count": 0,
        "decisive": None,
        "required": None,
        **_noise_fields(_absent_noise(rule["minimum_effect"])),
    }


def wilson_proportion(successes: int, trials: int, confidence: float = 0.9) -> dict[str, float]:
    if type(successes) is not int or successes < 0:
        raise ValueError("Wilson successes must be a non-negative integer.")
    if type(trials) is not int or trials <= 0:
        raise ValueError("Wilson trials must be a positive integer.")
    if successes > trials:
        raise ValueError("Wilson successes cannot exceed trials.")
    z = normal_z(confidence)
    p = successes / trials
    z2 = z * z
    denom = 1 + z2 / trials
    center = (p + z2 / (2 * trials)) / denom
    margin = (z * math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom
    lower = 0.0 if successes == 0 else _clamp01(center - margin)
    upper = 1.0 if successes == trials else _clamp01(center + margin)
    return {"rate": p, "lower": lower, "upper": upper}


def newcombe_interval(counts: dict[str, int], confidence: float = 0.9) -> dict[str, float]:
    _validate_counts(counts)
    left = wilson_proportion(counts["candidate_successes"], counts["candidate_trials"], confidence)
    right = wilson_proportion(counts["incumbent_successes"], counts["incumbent_trials"], confidence)
    effect = left["rate"] - right["rate"]
    lower = effect - math.hypot(left["rate"] - left["lower"], right["upper"] - right["rate"])
    upper = effect + math.hypot(left["upper"] - left["rate"], right["rate"] - right["lower"])
    return {"effect": effect, "lower": lower, "upper": upper}


def bootstrap_mean_interval(values: list[float], parameters: dict[str, Any]) -> dict[str, float]:
    """Same draws as ``mulberry32``, kept in unsigned 32-bit words."""
    if not values:
        raise ValueError("Bootstrap needs at least one value.")
    width = len(values)
    effect = sum(values) / width
    state = parameters["seed"] & 0xFFFFFFFF
    means = []
    for _sample in range(parameters["samples"]):
        total = 0.0
        for _index in range(width):
            state = (state + 0x6D2B79F5) & 0xFFFFFFFF
            word = ((state ^ (state >> 15)) * (state | 1)) & 0xFFFFFFFF
            mixed = ((word ^ (word >> 7)) * (word | 61)) & 0xFFFFFFFF
            word = ((word + mixed) ^ word) & 0xFFFFFFFF
            total += values[math.floor(((word ^ (word >> 14)) / 4294967296) * width)]
        means.append(total / width)
    means.sort()
    tail = (1 - parameters["confidence"]) / 2
    return {
        "effect": effect,
        "lower": _percentile(means, tail),
        "upper": _percentile(means, 1 - tail),
    }


def mulberry32(seed: int):
    """Same stream as the Node gate. ``Math.imul`` and ``| 0`` are signed int32."""
    state = _i32(seed)

    def _next() -> float:
        nonlocal state
        state = _i32(state + 0x6D2B79F5)
        unsigned = state & 0xFFFFFFFF
        t = _imul(_xor32(state, unsigned >> 15), _i32(1 | unsigned))
        unsigned_t = t & 0xFFFFFFFF
        mixed = _imul(_xor32(t, unsigned_t >> 7), _i32(61 | unsigned_t))
        t = _xor32(_i32(t + mixed), t)
        unsigned_t = t & 0xFFFFFFFF
        return (_xor32(t, unsigned_t >> 14) & 0xFFFFFFFF) / 4294967296

    return _next


def normal_z(confidence: float) -> float:
    if not 0 < confidence < 1:
        raise ValueError("Confidence must be between 0 and 1.")
    if confidence == 0.95:
        return _Z_95
    if confidence == 0.9:
        return _Z_90
    return _inverse_norm(1 - (1 - confidence) / 2)


def observed_noise_floor(items: list[dict[str, Any]], parameters: dict[str, Any]) -> dict[str, Any]:
    """Upper bound on the absolute mean of two incumbent runs.

    Diffs are second minus first. The bound is the farther endpoint of the
    same two-sided percentile interval the gate uses for a candidate. Items
    are sorted by UTF-8 id and the draw restarts from the gate seed.
    """
    if not items:
        raise ValueError("Noise floor needs at least one item.")
    ordered = sorted(items, key=lambda item: str(item.get("id", "")).encode("utf-8"))
    seen: set[str] = set()
    diffs = []
    for item in ordered:
        item_id = item.get("id")
        if type(item_id) is not str or not item_id:
            raise ValueError("Paired item id must be a non-empty string.")
        if item_id in seen:
            raise ValueError(f"Duplicate paired item id {item_id}.")
        seen.add(item_id)
        first, second = item["first"], item["second"]
        if (
            isinstance(first, bool)
            or isinstance(second, bool)
            or not isinstance(first, (int, float))
            or not isinstance(second, (int, float))
            or not math.isfinite(first)
            or not math.isfinite(second)
        ):
            raise ValueError("Paired scores must be finite.")
        diffs.append(second - first)
    interval = bootstrap_mean_interval(diffs, parameters)
    return {
        "value": max(abs(interval["lower"]), abs(interval["upper"])),
        "effect": interval["effect"],
        "lower": interval["lower"],
        "upper": interval["upper"],
        "items": len(diffs),
    }


def _decide_paired(
    items: list[dict[str, Any]], sign: int, parameters: dict[str, Any]
) -> dict[str, Any]:
    ordered = _ordered_pairs(items)
    noise = _noise_from_repeats(ordered, parameters)
    diffs = []
    decisive = 0
    for item in ordered:
        if item["candidate"] != item["incumbent"]:
            decisive += 1
        diffs.append(sign * (item["candidate"] - item["incumbent"]))
    required = _decisive_requirement(parameters)
    if required is not None and decisive < required:
        return _insufficient(
            sum(diffs) / len(diffs), len(diffs), decisive, required, "paired-bootstrap", noise
        )
    if parameters["minimum_items"] > 0 and len(diffs) < parameters["minimum_items"]:
        return _blocked(
            "minimum_items",
            sum(diffs) / len(diffs),
            len(diffs),
            decisive,
            required,
            "paired-bootstrap",
            noise,
        )
    interval = bootstrap_mean_interval(diffs, parameters)
    return _finish(interval, len(diffs), decisive, required, "paired-bootstrap", noise)


def _decide_unpaired(
    counts: dict[str, int], sign: int, parameters: dict[str, Any]
) -> dict[str, Any]:
    _validate_counts(counts)
    item_count = min(counts["candidate_trials"], counts["incumbent_trials"])
    effect = sign * (
        counts["candidate_successes"] / counts["candidate_trials"]
        - counts["incumbent_successes"] / counts["incumbent_trials"]
    )
    # Unpaired counts have no per-item scores, so the decisive-item guard does not run.
    noise = _absent_noise(parameters["minimum_effect"])
    if parameters["minimum_items"] > 0 and item_count < parameters["minimum_items"]:
        return _blocked("minimum_items", effect, item_count, None, None, "newcombe-wilson", noise)
    interval = newcombe_interval(counts, parameters["confidence"])
    directed = (
        interval
        if sign == 1
        else {
            "effect": -interval["effect"],
            "lower": -interval["upper"],
            "upper": -interval["lower"],
        }
    )
    return _finish(directed, item_count, None, None, "newcombe-wilson", noise)


def _decisive_requirement(parameters: dict[str, Any]) -> int | None:
    required = parameters.get("minimum_decisive") or 0
    return required if required > 0 else None


def _finish(
    interval: dict[str, float],
    item_count: int,
    decisive: int | None,
    required: int | None,
    method: str,
    noise: dict[str, Any],
) -> dict[str, Any]:
    accept = interval["lower"] > noise["bar"]
    return {
        "accept": accept,
        "outcome": "accepted" if accept else "rejected",
        "reason": "accepted" if accept else "below_minimum_effect",
        "lower": interval["lower"],
        "upper": interval["upper"],
        "effect": interval["effect"],
        "method": method,
        "item_count": item_count,
        "decisive": decisive,
        "required": required,
        **_noise_fields(noise),
    }


def _blocked(
    reason: str,
    effect: float,
    item_count: int,
    decisive: int | None,
    required: int | None,
    method: str,
    noise: dict[str, Any],
) -> dict[str, Any]:
    return {
        "accept": False,
        "outcome": "rejected",
        "reason": reason,
        "lower": None,
        "upper": None,
        "effect": effect,
        "method": method,
        "item_count": item_count,
        "decisive": decisive,
        "required": required,
        **_noise_fields(noise),
    }


def _insufficient(
    effect: float,
    item_count: int,
    decisive: int,
    required: int,
    method: str,
    noise: dict[str, Any],
) -> dict[str, Any]:
    return {
        "accept": False,
        "outcome": "insufficient",
        "reason": "insufficient_decisive",
        "lower": None,
        "upper": None,
        "effect": effect,
        "method": method,
        "item_count": item_count,
        "decisive": decisive,
        "required": required,
        **_noise_fields(noise),
    }


def _noise_from_repeats(items: list[dict[str, Any]], parameters: dict[str, Any]) -> dict[str, Any]:
    present = [item for item in items if "incumbentRepeat" in item]
    if not present:
        return _absent_noise(parameters["minimum_effect"])
    if len(present) != len(items):
        raise ValueError("Incumbent repeat scores must cover every item.")
    measured = observed_noise_floor(
        [
            {"id": item["id"], "first": item["incumbent"], "second": item["incumbentRepeat"]}
            for item in items
        ],
        parameters,
    )
    return _applied_noise(parameters["minimum_effect"], measured["value"], measured["items"])


def _absent_noise(minimum_effect: float) -> dict[str, Any]:
    return {
        "record": {"value": None, "method": "not_measured", "items": None, "calls": None},
        "effective": None,
        "binding": None,
        "bar": minimum_effect,
    }


def _applied_noise(minimum_effect: float, value: float, count: int) -> dict[str, Any]:
    if value > minimum_effect:
        binding = "noise_floor"
    elif value < minimum_effect:
        binding = "minimum_effect"
    else:
        binding = "tie"
    effective = max(minimum_effect, value)
    return {
        "record": {"value": value, "method": "paired-bootstrap", "items": count, "calls": count},
        "effective": effective,
        "binding": binding,
        "bar": effective,
    }


def _noise_fields(noise: dict[str, Any]) -> dict[str, Any]:
    return {
        "noise_floor": noise["record"],
        "effective_threshold": noise["effective"],
        "binding_threshold": noise["binding"],
    }


def _validate_parameters(parameters: dict[str, Any]) -> None:
    if not math.isfinite(parameters["minimum_effect"]):
        raise ValueError("minimum_effect must be finite.")
    confidence = parameters["confidence"]
    if not 0 < confidence < 1:
        raise ValueError("Confidence must be between 0 and 1.")
    samples = parameters["samples"]
    if type(samples) is not int or samples < 100 or samples > MAX_BOOTSTRAP_SAMPLES:
        raise ValueError(
            f"Bootstrap sample count must be an integer from 100 to {MAX_BOOTSTRAP_SAMPLES}."
        )
    seed = parameters["seed"]
    if type(seed) is not int or isinstance(seed, bool):
        raise ValueError("Bootstrap seed must be an integer.")
    minimum = parameters["minimum_items"]
    if type(minimum) is not int or minimum < 0:
        raise ValueError("minimum_items must be a non-negative integer.")
    decisive = parameters.get("minimum_decisive", 0)
    if type(decisive) is not int or decisive < 0:
        raise ValueError("minimum_decisive must be a non-negative integer.")


def _validate_counts(counts: dict[str, int]) -> None:
    pairs = (
        ("candidate", counts["candidate_successes"], counts["candidate_trials"]),
        ("incumbent", counts["incumbent_successes"], counts["incumbent_trials"]),
    )
    for name, successes, trials in pairs:
        if type(successes) is not int or successes < 0:
            raise ValueError(f"{name} successes must be a non-negative integer.")
        if type(trials) is not int or trials <= 0:
            raise ValueError(f"{name} trials must be a positive integer.")
        if successes > trials:
            raise ValueError(f"{name} successes cannot exceed trials.")


def _percentile(sorted_values: list[float], p: float) -> float:
    if len(sorted_values) == 1:
        return sorted_values[0]
    index = (len(sorted_values) - 1) * p
    low = math.floor(index)
    high = math.ceil(index)
    if low == high:
        return sorted_values[low]
    weight = index - low
    return sorted_values[low] * (1 - weight) + sorted_values[high] * weight


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _ordered_pairs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(items, key=lambda item: str(item.get("id", "")).encode("utf-8"))
    seen: set[str] = set()
    for item in ordered:
        item_id = item.get("id")
        if type(item_id) is not str or not item_id:
            raise ValueError("Paired item id must be a non-empty string.")
        if item_id in seen:
            raise ValueError(f"Duplicate paired item id {item_id}.")
        seen.add(item_id)
        repeat = item.get("incumbentRepeat", None) if "incumbentRepeat" in item else None
        if (
            isinstance(item["incumbent"], bool)
            or isinstance(item["candidate"], bool)
            or not math.isfinite(item["incumbent"])
            or not math.isfinite(item["candidate"])
            or (
                "incumbentRepeat" in item
                and (
                    isinstance(repeat, bool)
                    or not isinstance(repeat, (int, float))
                    or not math.isfinite(repeat)
                )
            )
        ):
            raise ValueError("Paired scores must be finite.")
    return ordered


def _i32(value: int) -> int:
    value &= 0xFFFFFFFF
    if value >= 0x80000000:
        value -= 0x100000000
    return value


def _imul(left: int, right: int) -> int:
    return _i32(_i32(left) * _i32(right))


def _xor32(left: int, right: int) -> int:
    return _i32((left & 0xFFFFFFFF) ^ (right & 0xFFFFFFFF))


def _inverse_norm(p: float) -> float:
    a = (
        -3.969683028665376e1,
        2.209460984245205e2,
        -2.759285104469687e2,
        1.38357751867269e2,
        -3.066479806614716e1,
        2.506628277459239,
    )
    b = (
        -5.447609879822406e1,
        1.615858368580409e2,
        -1.556989798598866e2,
        6.680131188771972e1,
        -1.328068155288572e1,
    )
    c = (
        -7.784894002430293e-3,
        -3.223964580411365e-1,
        -2.400758277161838,
        -2.549732539343734,
        4.374664141464968,
        2.938163982698783,
    )
    d = (
        7.784695709041462e-3,
        3.224671290700398e-1,
        2.445134137142996,
        3.754408661907416,
    )
    plow = 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
        )
    if p > 1 - plow:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        )
    q = p - 0.5
    r = q * q
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (
        ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1
    )
