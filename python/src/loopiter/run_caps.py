"""Optional monthly currency budget and UTC runs-per-day, charged before a model call."""

import math

from . import _validation as v


def validate_caps(value):
    v.fields(value, ["monthly_budget", "call_cost", "runs_per_day"])
    if "monthly_budget" in value:
        v.finite(value["monthly_budget"], "monthly_budget", 0)
        if "call_cost" not in value:
            v.fail("invalid_input", "monthly_budget requires call_cost.")
    if "call_cost" in value:
        v.finite(value["call_cost"], "call_cost", 0)
    if "runs_per_day" in value:
        v.integer(value["runs_per_day"], "runs_per_day", 0)


def is_model_operation(kind):
    return kind.startswith(("propose:", "validation:", "audit:"))


def counts_as_run(kind):
    return kind == "propose:0"


def _parts(now):
    v.timestamp(now, "clock")
    return now[:7], now[:10]


def _amount(data):
    if data is None:
        return 0
    if "amount" not in data:
        v.fail("invalid_state", "Cap spend is missing amount.")
    value = data["amount"]
    if (
        isinstance(value, bool)
        or type(value) not in (int, float)
        or not math.isfinite(value)
        or value < 0
    ):
        v.fail("invalid_state", "Cap spend amount must be a finite number >= 0.")
    return value


def _count(data):
    if data is None:
        return 0
    if "count" not in data:
        v.fail("invalid_state", "Cap run count is missing count.")
    value = data["count"]
    if type(value) is not int or value < 0:
        v.fail("invalid_state", "Cap run count must be an integer >= 0.")
    return value


async def cap_block(tx, caps, now, kind, scope):
    if not caps or not is_model_operation(kind):
        return None
    month, day = _parts(now)
    if "runs_per_day" in caps and counts_as_run(kind):
        row = await tx.get("coordination", f"cap-runs:{scope}:{day}")
        runs = _count(row["data"] if row else None)
        if runs >= caps["runs_per_day"]:
            return "daily_run_cap"
    cost = caps.get("call_cost", 0)
    if "monthly_budget" in caps:
        row = await tx.get("coordination", f"cap-spend:{scope}:{month}")
        spent = _amount(row["data"] if row else None)
        if spent + cost > caps["monthly_budget"]:
            return "budget_cap"
    return None


async def _write(tx, namespace, now, key, data):
    old = await tx.get("coordination", key)
    if old:
        row = {
            **old,
            "revision": old["revision"] + 1,
            "updated_at": old["updated_at"] if old["updated_at"] > now else now,
            "format": 1,
            "data": data,
        }
        try:
            await tx.replace("coordination", row, old["revision"])
        except Exception as exc:
            if getattr(exc, "code", None) == "conflict":
                v.fail("cap_conflict", "Cap counter changed; no spend.")
            raise
    else:
        try:
            await tx.insert(
                "coordination",
                {
                    "id": key,
                    "namespace": namespace,
                    "revision": 1,
                    "created_at": now,
                    "updated_at": now,
                    "format": 1,
                    "data": data,
                },
            )
        except Exception as exc:
            if getattr(exc, "code", None) == "conflict":
                v.fail("cap_conflict", "Cap counter changed; no spend.")
            raise


async def admit_model_call(tx, namespace, caps, now, kind, scope):
    block = await cap_block(tx, caps, now, kind, scope)
    if block == "budget_cap":
        v.fail("budget_cap", "Monthly budget reached.")
    if block == "daily_run_cap":
        v.fail("daily_run_cap", "Daily run cap reached.")
    if not caps or not is_model_operation(kind):
        return
    month, day = _parts(now)
    if "monthly_budget" in caps:
        key = f"cap-spend:{scope}:{month}"
        row = await tx.get("coordination", key)
        spent = _amount(row["data"] if row else None)
        await _write(tx, namespace, now, key, {"amount": spent + caps.get("call_cost", 0)})
    if "runs_per_day" in caps and counts_as_run(kind):
        key = f"cap-runs:{scope}:{day}"
        row = await tx.get("coordination", key)
        runs = _count(row["data"] if row else None)
        await _write(tx, namespace, now, key, {"count": runs + 1})
