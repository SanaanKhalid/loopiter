"""Historical batch import. Stores the documented record and does not run the application."""

from __future__ import annotations

import json
from typing import Any

from .._validation import LoopiterError, nonempty, obj, timestamp

_STATUSES = ("success", "partial", "error", "abstained", "dropped")
_USAGE = ("known", "estimated", "unknown")
_REPLAY_REASON = "imported-for-regression"
_RECORD_FIELDS = (
    "idempotencyKey",
    "occurredAt",
    "status",
    "parentId",
    "stageId",
    "versions",
    "usage",
    "replay",
)


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


async def import_batch(loop: Any, records: list[Any]) -> dict[str, int]:
    """Accept the record schema from the integration design. Same key and body is a no-op."""
    if type(records) is not list:
        raise TypeError("import_batch requires a list of records.")
    result = {"accepted": 0, "conflicts": 0, "rejected": 0}
    for record in records:
        try:
            body = _normalize(record)
        except (LoopiterError, TypeError):
            result["rejected"] += 1
            continue
        async with loop.store.transaction(loop.namespace) as tx:
            existing = await tx.get("historical", body["idempotencyKey"])
            if existing is not None:
                outcome = (
                    "accepted"
                    if _canonical(existing["original"]) == _canonical(body)
                    else "conflicts"
                )
            else:
                await tx.insert(
                    "historical",
                    {
                        "id": body["idempotencyKey"],
                        "namespace": loop.namespace,
                        "revision": 1,
                        "created_at": body["occurredAt"],
                        "updated_at": body["occurredAt"],
                        "original": body,
                    },
                )
                outcome = "accepted"
        result[outcome] += 1
    return result


def _normalize(record: Any) -> dict[str, Any]:
    obj(record, "import record")
    if set(record) - set(_RECORD_FIELDS):
        raise LoopiterError("invalid_input", "Unknown import field.")
    nonempty(record.get("idempotencyKey"), "idempotencyKey")
    timestamp(record.get("occurredAt"), "occurredAt")
    if record.get("status") not in _STATUSES:
        raise LoopiterError("invalid_input", "Invalid import status.")
    body: dict[str, Any] = {
        "idempotencyKey": record["idempotencyKey"],
        "occurredAt": record["occurredAt"],
        "status": record["status"],
    }
    for key in ("parentId", "stageId"):
        if key in record:
            nonempty(record[key], key)
            body[key] = record[key]
    if "versions" in record:
        body["versions"] = _versions(record["versions"])
    body["usage"] = _usage(record.get("usage"))
    body["replay"] = _replay(record.get("replay"))
    return body


def _versions(value: Any) -> dict[str, str]:
    obj(value, "versions")
    if set(value) - {"prompt", "model", "config"}:
        raise LoopiterError("invalid_input", "Unknown version field.")
    body: dict[str, str] = {}
    for key in ("prompt", "model", "config"):
        if key in value:
            nonempty(value[key], key)
            body[key] = value[key]
    return body


def _usage(value: Any) -> dict[str, Any]:
    obj(value, "usage")
    if set(value) - {"state", "tokens"}:
        raise LoopiterError("invalid_input", "Unknown usage field.")
    if value.get("state") not in _USAGE:
        raise LoopiterError("invalid_input", "Invalid usage state.")
    if value["state"] == "unknown":
        if "tokens" in value:
            raise LoopiterError("invalid_input", "Unknown usage cannot be stored as a token count.")
        return {"state": "unknown"}
    body: dict[str, Any] = {"state": value["state"]}
    if "tokens" in value:
        tokens = value["tokens"]
        if type(tokens) is not int or tokens < 0:
            raise LoopiterError("invalid_input", "Invalid tokens.")
        body["tokens"] = tokens
    return body


def _replay(value: Any) -> dict[str, Any]:
    if value is None:
        return {"eligible": False}
    obj(value, "replay")
    if set(value) - {"eligible", "reason"}:
        raise LoopiterError("invalid_input", "Unknown replay field.")
    eligible = False if "eligible" not in value else value["eligible"]
    if type(eligible) is not bool:
        raise LoopiterError("invalid_input", "replay.eligible must be boolean.")
    if not eligible:
        body: dict[str, Any] = {"eligible": False}
        if "reason" in value:
            nonempty(value["reason"], "replay.reason")
            body["reason"] = value["reason"]
        return body
    nonempty(value.get("reason"), "replay.reason")
    if value["reason"] != _REPLAY_REASON:
        raise LoopiterError("invalid_input", "Replay reason is not allowed for an imported row.")
    return {"eligible": True, "reason": _REPLAY_REASON}
