"""Historical batch import. Stores the documented record and does not run the application."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from .._validation import LoopiterError, nonempty, obj

DEFAULT_MAX_RECORDS = 1000
DEFAULT_MAX_STRING_LENGTH = 4096

_OCCURRED_AT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")

_STATUSES = ("success", "partial", "error", "abstained", "dropped")
_USAGE = ("known", "estimated", "unknown")
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


async def import_batch(
    loop: Any,
    records: list[Any],
    *,
    max_records: int = DEFAULT_MAX_RECORDS,
    max_string_length: int = DEFAULT_MAX_STRING_LENGTH,
) -> dict[str, int]:
    """Accept the record schema from the integration design. Same key and body is a no-op."""
    if type(records) is not list:
        raise TypeError("import_batch requires a list of records.")
    if type(max_records) is not int or max_records < 1:
        raise TypeError("max_records must be a positive integer.")
    if type(max_string_length) is not int or max_string_length < 1:
        raise TypeError("max_string_length must be a positive integer.")
    if len(records) > max_records:
        raise LoopiterError(
            "invalid_input", f"import batch exceeds the maximum of {max_records} records."
        )
    result = {"accepted": 0, "conflicts": 0, "rejected": 0}
    for record in records:
        try:
            _assert_string_cap(record, max_string_length)
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


def _occurred_at(value: Any) -> None:
    """Same UTC width as the Node importer: optional 1–3 fractional digits, ending in Z."""
    if type(value) is not str or _OCCURRED_AT.fullmatch(value) is None:
        raise LoopiterError("invalid_input", "occurredAt must be an ISO UTC timestamp ending in Z.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise LoopiterError("invalid_input", "Invalid calendar date in occurredAt.") from None
    rendered = parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    if rendered[:19] != value[:19]:
        raise LoopiterError("invalid_input", "Invalid calendar date in occurredAt.")


def _normalize(record: Any) -> dict[str, Any]:
    obj(record, "import record")
    if set(record) - set(_RECORD_FIELDS):
        raise LoopiterError("invalid_input", "Unknown import field.")
    nonempty(record.get("idempotencyKey"), "idempotencyKey")
    _occurred_at(record.get("occurredAt"))
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


def _assert_string_cap(value: Any, max_length: int, path: str = "record") -> None:
    if isinstance(value, str):
        if len(value) > max_length:
            raise LoopiterError(
                "invalid_input", f"Import string exceeds the maximum length of {max_length}."
            )
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _assert_string_cap(key, max_length, path)
            _assert_string_cap(item, max_length, path)
        return
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        for item in value:
            _assert_string_cap(item, max_length, path)


def _replay(value: Any) -> dict[str, Any]:
    if value is None:
        return {"eligible": False}
    obj(value, "replay")
    if set(value) - {"eligible", "reason"}:
        raise LoopiterError("invalid_input", "Unknown replay field.")
    if "eligible" in value and type(value["eligible"]) is not bool:
        raise LoopiterError("invalid_input", "replay.eligible must be boolean.")
    if value.get("eligible") is True or "reason" in value:
        raise LoopiterError(
            "invalid_input", "Import replay eligibility is assigned by the importer."
        )
    return {"eligible": False}
