"""Served-answer ids, feedback records, and the improvement cursor."""

import re
from copy import deepcopy

from . import _validation as v

CONTROL = re.compile(r"[\x00-\x1f\x7f]")
ANSWER_FIELDS = ["namespace", "answer", "episodeId", "artifactVersion"]
FEEDBACK_FIELDS = ["answerId", "rating", "edit", "note"]
LIMITS = {
    "namespace": 200,
    "answer": 100_000,
    "episodeId": 200,
    "artifactVersion": 200,
    "answerId": 80,
    "edit": 100_000,
    "note": 4_000,
}
FEEDBACK_CURSOR_ID = "feedback-cursor"


def _text(value, name, limit):
    if type(value) is not str:
        v.fail("invalid_input", f"{name} must be text.")
    v.nonempty(value, name)
    if len(value) > limit:
        v.fail("invalid_input", f"{name} exceeds {limit} characters.")
    if CONTROL.search(value):
        v.fail("invalid_input", f"{name} contains a control character.")
    return value


def served_answer_id(value):
    """Stable id. Canonical keys match Node: namespace, answer, episodeId, artifactVersion."""
    v.fields(value, ANSWER_FIELDS, ("namespace", "answer"))
    canonical = {
        "namespace": _text(value["namespace"], "namespace", LIMITS["namespace"]),
        "answer": _text(value["answer"], "answer", LIMITS["answer"]),
    }
    if "episodeId" in value:
        canonical["episodeId"] = _text(value["episodeId"], "episodeId", LIMITS["episodeId"])
    if "artifactVersion" in value:
        canonical["artifactVersion"] = _text(
            value["artifactVersion"], "artifactVersion", LIMITS["artifactVersion"]
        )
    return "ans_" + v.fingerprint(canonical)


def _rating(value):
    v.fields(value, ["kind", "value"], ("kind", "value"))
    if value["kind"] == "numeric":
        v.finite(value["value"], "rating", 0)
        if value["value"] > 1:
            v.fail("invalid_input", "Numeric rating must be from 0 to 1.")
        return {"kind": "numeric", "value": value["value"]}
    if value["kind"] == "thumbs":
        if value["value"] not in ("up", "down"):
            v.fail("invalid_input", "Thumbs rating must be up or down.")
        return {"kind": "thumbs", "value": value["value"]}
    v.fail("invalid_input", "Rating kind must be numeric or thumbs.")
    raise AssertionError("unreachable")


def feedback_input(value):
    v.fields(value, FEEDBACK_FIELDS, ("answerId",))
    parsed = {"answerId": _text(value["answerId"], "answerId", LIMITS["answerId"])}
    if "rating" in value:
        parsed["rating"] = _rating(value["rating"])
    if "edit" in value:
        parsed["edit"] = _text(value["edit"], "edit", LIMITS["edit"])
    if "note" in value:
        parsed["note"] = _text(value["note"], "note", LIMITS["note"])
    if "rating" not in parsed and "edit" not in parsed:
        v.fail("invalid_input", "Feedback needs a rating or a corrected edit.")
    return parsed


def feedback_record_id(parsed):
    canonical = {"answerId": parsed["answerId"]}
    if "rating" in parsed:
        canonical["rating"] = parsed["rating"]
    if "edit" in parsed:
        canonical["edit"] = parsed["edit"]
    if "note" in parsed:
        canonical["note"] = parsed["note"]
    return "feedback:" + v.fingerprint(canonical)


def empty_feedback_cursor():
    return {"position": None, "previous": None, "promotion_id": None}


def _ordered(rows):
    return sorted(rows, key=lambda row: (row["recorded_at"], row["id"]))


def advance_feedback_cursor(cursor, rows, promotion_id):
    v.nonempty(promotion_id, "promotion_id")
    if cursor["promotion_id"] == promotion_id:
        return cursor
    ordered = _ordered(rows)
    if not ordered:
        return cursor
    latest = ordered[-1]
    return {
        "position": latest["id"],
        "previous": cursor["position"],
        "promotion_id": promotion_id,
    }


def rewind_feedback_cursor(cursor, promotion_id):
    if cursor["promotion_id"] != promotion_id:
        return cursor
    return {"position": cursor["previous"], "previous": None, "promotion_id": None}


def _same(left, right):
    return (
        left["position"] == right["position"]
        and left["previous"] == right["previous"]
        and left["promotion_id"] == right["promotion_id"]
    )


def _read_cursor(data):
    if not data:
        return empty_feedback_cursor()
    return {
        "position": data["position"] if type(data.get("position")) is str else None,
        "previous": data["previous"] if type(data.get("previous")) is str else None,
        "promotion_id": data["promotion_id"] if type(data.get("promotion_id")) is str else None,
    }


def is_promotion(state, reason):
    return state == "completed" and reason in (
        "offline_pass_and_production_limits_met_not_causal_proof",
        "canary_promoted",
    )


async def _list_all(tx, collection):
    rows, cursor = [], None
    while True:
        page = await tx.list(collection, limit=1000, cursor=cursor)
        rows.extend(page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return rows


async def _write(tx, namespace, now, key, data):
    v.timestamp(now, "clock")
    old = await tx.get("coordination", key)
    if old:
        row = {
            **old,
            "revision": old["revision"] + 1,
            "updated_at": old["updated_at"] if old["updated_at"] > now else now,
            "format": 1,
            "data": deepcopy(data),
        }
        await tx.replace("coordination", row, old["revision"])
    else:
        await tx.insert(
            "coordination",
            {
                "id": key,
                "namespace": namespace,
                "revision": 1,
                "created_at": now,
                "updated_at": now,
                "format": 1,
                "data": deepcopy(data),
            },
        )


async def persist_feedback(tx, namespace, now, parsed):
    key = feedback_record_id(parsed)
    existing = await tx.get("coordination", key)
    if existing:
        return {"id": key, "recorded_at": existing["data"]["recorded_at"]}
    data = {"kind": "feedback", "answer_id": parsed["answerId"], "recorded_at": now}
    if "rating" in parsed:
        data["rating"] = parsed["rating"]
    if "edit" in parsed:
        data["edit"] = parsed["edit"]
    if "note" in parsed:
        data["note"] = parsed["note"]
    await _write(tx, namespace, now, key, data)
    return {"id": key, "recorded_at": now}


async def apply_feedback_cursor(tx, namespace, now, action, promotion_id):
    rows = await _list_all(tx, "coordination")
    current = next((row for row in rows if row["id"] == FEEDBACK_CURSOR_ID), None)
    cursor = _read_cursor(current["data"] if current else None)
    feedback = [
        {"id": row["id"], "recorded_at": row["data"]["recorded_at"]}
        for row in rows
        if row["data"].get("kind") == "feedback" and type(row["data"].get("recorded_at")) is str
    ]
    nxt = (
        advance_feedback_cursor(cursor, feedback, promotion_id)
        if action == "promote"
        else rewind_feedback_cursor(cursor, promotion_id)
    )
    if not _same(cursor, nxt):
        await _write(
            tx,
            namespace,
            now,
            FEEDBACK_CURSOR_ID,
            {
                "kind": "feedback-cursor",
                "position": nxt["position"],
                "previous": nxt["previous"],
                "promotion_id": nxt["promotion_id"],
            },
        )
    return nxt
