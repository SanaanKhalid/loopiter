"""Read-only explanation of an acceptance decision log.

Checks that were not recorded stay null. A missing count is null, not 0.
The JSON log uses the Node benchmark's camelCase fields.
"""

from __future__ import annotations

import json
from typing import Any

from .acceptance_gate import MAX_BOOTSTRAP_SAMPLES

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
    return json.dumps(log, indent=2) + "\n"


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


def _format_check(seed: int, candidate_id: str, split: str, check: dict[str, Any] | None) -> str:
    quoted = json.dumps(candidate_id)
    if check is None:
        return f"seed {seed} {quoted} {split} null"
    return " ".join(
        [
            f"seed {seed}",
            quoted,
            split,
            f"round {check['round']}",
            check["outcome"],
            f"reason {json.dumps(check['reason'])}",
            f"effect {_show(check['effect'])}",
            f"lower {_show(check['lower'])}",
            f"upper {_show(check['upper'])}",
            f"threshold {_show(check['threshold'])}",
            f"decisive {_show(check['decisive'])}",
            f"required {_show(check['required'])}",
        ]
    )


def _show(value: Any) -> str:
    if value is None:
        return "null"
    return json.dumps(value)
