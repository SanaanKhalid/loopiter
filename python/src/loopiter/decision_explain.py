"""Read-only explanation of an acceptance decision log.

Checks that were not recorded stay null. A missing count is null, not 0.
The JSON log uses the Node benchmark's camelCase fields.
"""

from __future__ import annotations

import json
from typing import Any

from .acceptance_gate import MAX_BOOTSTRAP_SAMPLES, load_retention_ledger

_OUTCOMES = {"accepted", "rejected", "insufficient"}


def explain_decision_log(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        return explain_decision_text(handle.read())


def explain_decision_text(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("Decision log is not JSON.") from error
    if not isinstance(parsed, dict):
        raise ValueError("Decision log is not an acceptance-decisions file.")
    if (
        parsed.get("schemaVersion") != 1
        or parsed.get("kind") != "acceptance-decisions"
        or not isinstance(parsed.get("seeds"), list)
    ):
        raise ValueError("Decision log is not an acceptance-decisions file.")
    return {"seeds": [_explain_seed(seed) for seed in parsed["seeds"]]}


def format_explanation(log: dict[str, Any]) -> str:
    lines: list[str] = []
    for seed in log["seeds"]:
        if not seed["candidates"]:
            lines.append(f"seed {seed['seed']} no rounds")
            continue
        for candidate in seed["candidates"]:
            lines.append(
                _format_check(
                    seed["seed"], candidate["candidateId"], "validation", candidate["validation"]
                )
            )
            lines.append(
                _format_check(seed["seed"], candidate["candidateId"], "audit", candidate["audit"])
            )
    return "\n".join(lines) + "\n"


def format_explanation_json(log: dict[str, Any]) -> str:
    return json.dumps(log, indent=2, ensure_ascii=True) + "\n"


def _explain_seed(value: Any) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("seed"), int)
        or not isinstance(value.get("rounds"), list)
    ):
        raise ValueError("Decision log seed is malformed.")
    grouped: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for round_ in value["rounds"]:
        explained = _explain_round(round_, value["seed"])
        key = explained["candidateId"] + "\0" + explained["promptHash"]
        candidate = grouped.get(key)
        if candidate is None:
            candidate = {
                "candidateId": explained["candidateId"],
                "promptHash": explained["promptHash"],
                "validation": None,
                "audit": None,
            }
            grouped[key] = candidate
            order.append(key)
        if candidate[explained["split"]] is not None:
            raise ValueError(
                f"Seed {value['seed']} repeats {explained['split']} for {explained['candidateId']}."
            )
        candidate[explained["split"]] = explained["check"]
    return {"seed": value["seed"], "candidates": [grouped[key] for key in order]}


def _explain_round(value: Any, seed: int) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("round"), int):
        raise ValueError(f"Seed {seed} has a malformed round.")
    if not isinstance(value.get("candidateId"), str) or not isinstance(
        value.get("promptHash"), str
    ):
        raise ValueError(f"Seed {seed} round {value['round']} is missing its candidate.")
    if value.get("split") not in ("validation", "audit"):
        raise ValueError(f"Seed {seed} round {value['round']} has an unknown split.")
    return {
        "candidateId": value["candidateId"],
        "promptHash": value["promptHash"],
        "split": value["split"],
        "check": _explain_decision(value.get("decision"), value.get("rule"), seed, value["round"]),
    }


def _explain_decision(value: Any, rule: Any, seed: int, round_: int) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("accept"), bool)
        or not isinstance(value.get("reason"), str)
    ):
        raise ValueError(f"Seed {seed} round {round_} has a malformed decision.")
    outcome = (
        _outcome_from(value["accept"], value["reason"])
        if "outcome" not in value
        else value["outcome"]
    )
    if outcome not in _OUTCOMES:
        raise ValueError(f"Seed {seed} round {round_} has an unknown outcome.")
    if outcome == "accepted" and value["accept"] is not True:
        raise ValueError(f"Seed {seed} round {round_} outcome does not match accept.")
    if outcome != "accepted" and value["accept"] is not False:
        raise ValueError(f"Seed {seed} round {round_} outcome does not match accept.")
    return {
        "round": round_,
        "outcome": outcome,
        "reason": value["reason"],
        "effect": _number_or_null(value.get("effect"), seed, round_, "effect"),
        "lower": _number_or_null(value.get("lower"), seed, round_, "lower"),
        "upper": _number_or_null(value.get("upper"), seed, round_, "upper"),
        "threshold": _rule_threshold(rule, seed, round_),
        "decisive": _count_or_null(value, "decisive", seed, round_),
        "required": _count_or_null(value, "required", seed, round_),
        "noiseFloor": _read_noise(value.get("noiseFloor"), seed, round_),
        "effectiveThreshold": _read_effective(value.get("effectiveThreshold"), seed, round_),
        "bindingThreshold": _read_binding(value.get("bindingThreshold"), seed, round_),
        "retention": _read_retention(value.get("retention"), f"Seed {seed} round {round_}"),
    }


def _outcome_from(accept: bool, reason: str) -> str:
    if accept:
        return "accepted"
    if reason == "insufficient_decisive":
        return "insufficient"
    return "rejected"


def _number_or_null(value: Any, seed: int, round_: int, name: str) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Seed {seed} round {round_} has a non-finite {name}.")
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"Seed {seed} round {round_} has a non-finite {name}.")
    return value


def _count_or_null(decision: dict[str, Any], name: str, seed: int, round_: int) -> int | None:
    if name not in decision or decision[name] is None:
        return None
    value = decision[name]
    if isinstance(value, bool) or type(value) is not int or value < 0:
        raise ValueError(f"Seed {seed} round {round_} has an invalid {name} count.")
    return value


def _rule_threshold(rule: Any, seed: int, round_: int) -> int | float:
    if not isinstance(rule, dict):
        raise ValueError(f"Seed {seed} round {round_} has a rule outside the documented bounds.")
    value = rule.get("minimumEffect")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise ValueError(f"Seed {seed} round {round_} has a rule outside the documented bounds.")
    samples = rule.get("samples")
    if isinstance(samples, bool) or (
        isinstance(samples, int) and (samples < 100 or samples > MAX_BOOTSTRAP_SAMPLES)
    ):
        raise ValueError(f"Seed {seed} round {round_} has a rule outside the documented bounds.")
    if "samples" in rule and type(samples) is not int:
        raise ValueError(f"Seed {seed} round {round_} has a rule outside the documented bounds.")
    decisive = rule.get("minimumDecisive")
    if "minimumDecisive" in rule and (
        isinstance(decisive, bool) or type(decisive) is not int or decisive < 0
    ):
        raise ValueError(f"Seed {seed} round {round_} has a rule outside the documented bounds.")
    return value


def _read_noise(value: Any, seed: int, round_: int) -> dict[str, Any]:
    if value is None:
        return _not_measured_noise()
    if not isinstance(value, dict):
        raise ValueError(f"Seed {seed} round {round_} has a malformed noise floor.")
    method = value.get("method")
    if method == "not_measured":
        if (
            value.get("value") is not None
            or value.get("items") is not None
            or value.get("calls") is not None
        ):
            raise ValueError(
                f"Seed {seed} round {round_} records an unmeasured noise floor as a number."
            )
        return _not_measured_noise()
    if method != "paired-bootstrap":
        raise ValueError(f"Seed {seed} round {round_} has an unknown noise floor method.")
    measured = value.get("value")
    if isinstance(measured, bool) or not isinstance(measured, (int, float)) or measured != measured:
        raise ValueError(f"Seed {seed} round {round_} has a non-finite noise floor.")
    if measured in (float("inf"), float("-inf")):
        raise ValueError(f"Seed {seed} round {round_} has a non-finite noise floor.")
    calls = value.get("calls")
    return {
        "value": measured,
        "method": "paired-bootstrap",
        "items": _noise_count(value.get("items"), seed, round_, "noise items"),
        "calls": None if calls is None else _noise_count(calls, seed, round_, "noise calls"),
    }


def _read_effective(value: Any, seed: int, round_: int) -> int | float | None:
    return _number_or_null(value, seed, round_, "effective threshold")


def _read_binding(value: Any, seed: int, round_: int) -> str | None:
    if value is None:
        return None
    if value in ("minimum_effect", "noise_floor", "tie"):
        return value
    raise ValueError(f"Seed {seed} round {round_} has an unknown binding threshold.")


def _not_measured_noise() -> dict[str, Any]:
    return {"value": None, "method": "not_measured", "items": None, "calls": None}


def _noise_count(value: Any, seed: int, round_: int, name: str) -> int:
    if isinstance(value, bool) or type(value) is not int or value < 0:
        raise ValueError(f"Seed {seed} round {round_} has an invalid {name} count.")
    return value


def _format_check(seed: int, candidate_id: str, split: str, check: dict[str, Any] | None) -> str:
    quoted = _show_text(candidate_id)
    if check is None:
        return f"seed {seed} {quoted} {split} null"
    binding = "null" if check["bindingThreshold"] is None else check["bindingThreshold"]
    return " ".join(
        [
            f"seed {seed}",
            quoted,
            split,
            f"round {check['round']}",
            check["outcome"],
            f"reason {_show_text(check['reason'])}",
            f"effect {_show(check['effect'])}",
            f"lower {_show(check['lower'])}",
            f"upper {_show(check['upper'])}",
            f"threshold {_show(check['threshold'])}",
            f"decisive {_show(check['decisive'])}",
            f"required {_show(check['required'])}",
            f"noise {_show(check['noiseFloor']['value'])}",
            f"method {check['noiseFloor']['method']}",
            f"noiseItems {_show(check['noiseFloor']['items'])}",
            f"calls {_show(check['noiseFloor']['calls'])}",
            f"effective {_show(check['effectiveThreshold'])}",
            f"binding {binding}",
            f"retention {check['retention']['outcome']}",
            f"retentionReason {_show_text(check['retention']['reason'])}",
            "bestEver "
            + (
                "null"
                if check["retention"]["bestEverId"] is None
                else _show_text(check["retention"]["bestEverId"])
            ),
            f"retentionLower {_show(check['retention']['lower'])}",
            f"margin {_show(check['retention']['margin'])}",
            f"retentionItems {_show(check['retention']['items'])}",
        ]
    )


def _show_text(value: str) -> str:
    """Quote text and escape every character outside printable ASCII, including DEL."""
    text = json.dumps(value, ensure_ascii=True)
    return "".join(
        _escape_unit(char) if ord(char) < 0x20 or ord(char) > 0x7E else char for char in text
    )


def _escape_unit(char: str) -> str:
    return "\\u" + format(ord(char), "04x")


def _show(value: Any) -> str:
    if value is None:
        return "null"
    return json.dumps(_canon_number(value))


_RETENTION_OUTCOMES = {"pass", "retention_regression", "insufficient", "not_measured"}


def empty_retention_status() -> dict[str, Any]:
    return {"bestEver": None, "decisions": []}


def retention_report_from_state(text: str, namespace: str) -> dict[str, Any]:
    """Read coordination retention rows from a v3 state file. Does not write."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("State file is not JSON.") from error
    if (
        not isinstance(parsed, dict)
        or parsed.get("version") != 3
        or not isinstance(parsed.get("namespaces"), dict)
    ):
        raise ValueError("State file is not a v3 store.")
    bucket = parsed["namespaces"].get(namespace)
    if not isinstance(bucket, dict):
        raise ValueError("State file has no such namespace.")
    coordination = bucket.get("coordination")
    if not isinstance(coordination, dict):
        return {"targets": []}
    targets = []
    for key in sorted(coordination, key=lambda item: item.encode("utf-8")):
        if not key.startswith("target:"):
            continue
        row = coordination[key]
        if not isinstance(row, dict) or not isinstance(row.get("data"), dict):
            continue
        if "retention" not in row["data"]:
            continue
        ledger = load_retention_ledger(_normalize_ledger(row["data"]["retention"]))
        targets.append(_target_status(key, ledger))
    return {"targets": targets}


def format_retention_report(report: dict[str, Any]) -> str:
    targets = report["targets"]
    if not targets:
        return "bestEver null score null items null\n"
    blocks = []
    for target in targets:
        body = format_retention_status(target).removesuffix("\n")
        blocks.append(f"target {_show_text(target['id'])}\n{body}")
    return "\n".join(blocks) + "\n"


def format_retention_report_json(report: dict[str, Any]) -> str:
    return json.dumps(_canon(report), ensure_ascii=True, indent=2) + "\n"


def _normalize_ledger(value: Any) -> dict[str, Any]:
    """Accept the Node camelCase store and the Python snake_case store."""
    if not isinstance(value, dict):
        return value
    decisions = value.get("decisions") or []
    best = value["best_ever"] if "best_ever" in value else value.get("bestEver")
    normalized = []
    for item in decisions:
        if not isinstance(item, dict):
            normalized.append(item)
            continue
        best_id = item["best_ever_id"] if "best_ever_id" in item else item.get("bestEverId")
        normalized.append(
            {
                "candidate_id": item.get("candidate_id", item.get("candidateId")),
                "outcome": item.get("outcome"),
                "reason": item.get("reason"),
                "best_ever_id": best_id,
                "lower": item.get("lower"),
                "margin": item.get("margin"),
                "items": item.get("items"),
            }
        )
    return {"best_ever": best, "decisions": normalized}


def _target_status(key: str, ledger: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": key,
        "bestEver": ledger["best_ever"],
        "decisions": [
            {
                "candidateId": decision["candidate_id"],
                "outcome": decision["outcome"],
                "reason": decision["reason"],
                "bestEverId": decision["best_ever_id"],
                "lower": decision["lower"],
                "margin": decision["margin"],
                "items": decision["items"],
            }
            for decision in ledger["decisions"]
        ],
    }


def format_retention_status(status: dict[str, Any]) -> str:
    best = status["bestEver"]
    lines = [
        "bestEver "
        + ("null" if best is None else _show_text(best["id"]))
        + f" score {_show(None if best is None else best['score'])}"
        + f" items {_show(None if best is None else len(best['items']))}"
    ]
    if best is not None:
        for item in best["items"]:
            lines.append(f"item {_show_text(item['id'])} {_show(item['score'])}")
    for decision in status["decisions"]:
        best_id = decision["bestEverId"]
        lines.append(
            " ".join(
                [
                    "decision",
                    _show_text(decision["candidateId"]),
                    decision["outcome"],
                    f"reason {_show_text(decision['reason'])}",
                    "bestEver " + ("null" if best_id is None else _show_text(best_id)),
                    f"lower {_show(decision['lower'])}",
                    f"margin {_show(decision['margin'])}",
                    f"items {_show(decision['items'])}",
                ]
            )
        )
    return "\n".join(lines) + "\n"


def format_retention_status_json(status: dict[str, Any]) -> str:
    return json.dumps(_canon(status), ensure_ascii=True, indent=2) + "\n"


def _not_measured_retention() -> dict[str, Any]:
    return {
        "outcome": "not_measured",
        "reason": "not_measured",
        "bestEverId": None,
        "lower": None,
        "margin": None,
        "items": None,
    }


def _read_retention(value: Any, where: str) -> dict[str, Any]:
    if value is None:
        return _not_measured_retention()
    if not isinstance(value, dict) or value.get("outcome") not in _RETENTION_OUTCOMES:
        raise ValueError(f"{where} has an unknown retention outcome.")
    if not isinstance(value.get("reason"), str):
        raise ValueError(f"{where} has a malformed retention check.")
    if value["outcome"] == "not_measured":
        if any(value.get(key) is not None for key in ("bestEverId", "lower", "margin", "items")):
            raise ValueError(f"{where} records an unmeasured retention check as a number.")
        return _not_measured_retention()
    best_id = value.get("bestEverId")
    if best_id is not None and not isinstance(best_id, str):
        raise ValueError(f"{where} has a malformed best-ever id.")
    items = value.get("items")
    if isinstance(items, bool) or type(items) is not int or items < 1:
        raise ValueError(f"{where} has an invalid retention item count.")
    margin = value.get("margin")
    if isinstance(margin, bool) or not isinstance(margin, (int, float)) or margin != margin:
        raise ValueError(f"{where} has a non-finite retention margin.")
    if value["outcome"] == "insufficient":
        if value.get("lower") is not None:
            raise ValueError(f"{where} records an unused retention bound.")
        return {
            "outcome": "insufficient",
            "reason": value["reason"],
            "bestEverId": best_id,
            "lower": None,
            "margin": margin,
            "items": items,
        }
    lower = value.get("lower")
    if isinstance(lower, bool) or not isinstance(lower, (int, float)) or lower != lower:
        raise ValueError(f"{where} has a non-finite retention lower bound.")
    return {
        "outcome": value["outcome"],
        "reason": value["reason"],
        "bestEverId": best_id,
        "lower": lower,
        "margin": margin,
        "items": items,
    }


def _canon_number(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _canon(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _canon(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_canon(item) for item in value]
    return _canon_number(value)
