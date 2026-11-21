"""Served-answer ids, per-target feedback, and the improvement cursor."""

import hashlib
import re
from copy import deepcopy

from . import _validation as v
from .eval_lock import canonical_json

CONTROL = re.compile(r"[\x00-\x1f\x7f]")
BLANK = set(
    "\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
ANSWER_FIELDS = ["namespace", "answer", "episodeId", "artifactVersion"]
FEEDBACK_FIELDS = ["answerId", "target", "rating", "edit", "note"]
LIMITS = {
    "namespace": 200,
    "answer": 100_000,
    "episodeId": 200,
    "artifactVersion": 200,
    "answerId": 80,
    "edit": 100_000,
    "note": 4_000,
    "targetKind": 64,
    "targetKey": 200,
}


def _points(value: str) -> int:
    return len(value)


def _blank(value: str) -> bool:
    return value == "" or all(character in BLANK for character in value)


def _text(value, name, limit):
    if type(value) is not str:
        v.fail("invalid_input", f"{name} must be text.")
    if CONTROL.search(value):
        v.fail("invalid_input", f"{name} contains a control character.")
    if _blank(value):
        v.fail("invalid_input", f"{name} must be nonempty text.")
    if _points(value) > limit:
        v.fail("invalid_input", f"{name} exceeds {limit} code points.")
    return value


def _digest(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def target_scope(target) -> str:
    return "target:" + v.fingerprint(target)


def feedback_cursor_id(scope: str) -> str:
    return "feedback-cursor:" + scope


def feedback_head_id(scope: str) -> str:
    return "feedback-head:" + scope


def served_answer_id(value):
    """Stable id. Canonical JSON matches the eval-set lock, including non-ASCII text."""
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
    return "ans_" + _digest(canonical)


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


def _target(value):
    v.fields(value, ["kind", "key"], ("kind", "key"))
    return {
        "kind": _text(value["kind"], "target.kind", LIMITS["targetKind"]),
        "key": _text(value["key"], "target.key", LIMITS["targetKey"]),
    }


def feedback_input(value):
    v.fields(value, FEEDBACK_FIELDS, ("answerId", "target"))
    parsed = {
        "answerId": _text(value["answerId"], "answerId", LIMITS["answerId"]),
        "target": _target(value["target"]),
    }
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
    canonical = {
        "answerId": parsed["answerId"],
        "target": {"kind": parsed["target"]["kind"], "key": parsed["target"]["key"]},
    }
    if "rating" in parsed:
        canonical["rating"] = parsed["rating"]
    if "edit" in parsed:
        canonical["edit"] = parsed["edit"]
    if "note" in parsed:
        canonical["note"] = parsed["note"]
    return "feedback:" + _digest(canonical)


def empty_feedback_cursor():
    return {
        "position": None,
        "position_at": None,
        "seq": None,
        "previous": None,
        "previous_at": None,
        "previous_seq": None,
        "promotion_id": None,
    }


def _seq(value, name, required=False):
    if value is None:
        if required:
            v.fail("invalid_state", f"{name} must be an integer >= 1.")
        return None
    if type(value) is not int or not 1 <= value <= 2**53 - 1:
        v.fail("invalid_state", f"{name} must be an integer >= 1.")
    return value


def _stored_time(value, name):
    try:
        v.timestamp(value, name)
    except v.LoopiterError as error:
        if error.code == "invalid_input":
            v.fail("invalid_state", f"{name} must be an ISO UTC timestamp ending in Z.")
        raise


def _nullable(value, name):
    if value is None:
        return None
    if type(value) is not str or _blank(value):
        v.fail("invalid_state", f"{name} must be a string or null.")
    return value


def _stored_fields(data, allowed):
    if type(data) is not dict:
        v.fail("invalid_state", "Stored feedback record is malformed.")
    if set(data) - set(allowed) or set(allowed) - set(data):
        v.fail("invalid_state", "Stored feedback record has unknown or missing fields.")


def read_cursor(data):
    if not data:
        return empty_feedback_cursor()
    _stored_fields(
        data,
        [
            "kind",
            "position",
            "position_at",
            "seq",
            "previous",
            "previous_at",
            "previous_seq",
            "promotion_id",
        ],
    )
    if data["kind"] != "feedback-cursor":
        v.fail("invalid_state", "Feedback cursor kind is wrong.")
    position = _nullable(data["position"], "position")
    previous = _nullable(data["previous"], "previous")
    promotion_id = _nullable(data["promotion_id"], "promotion_id")
    position_at = _nullable(data["position_at"], "position_at")
    previous_at = _nullable(data["previous_at"], "previous_at")
    seq = _seq(data["seq"], "seq")
    previous_seq = _seq(data["previous_seq"], "previous_seq")
    if position_at is not None:
        _stored_time(position_at, "position_at")
    if previous_at is not None:
        _stored_time(previous_at, "previous_at")
    if (position is None) != (position_at is None) or (position is None) != (seq is None):
        v.fail("invalid_state", "Feedback cursor position is incomplete.")
    if (previous is None) != (previous_at is None) or (previous is None) != (previous_seq is None):
        v.fail("invalid_state", "Feedback cursor previous position is incomplete.")
    return {
        "position": position,
        "position_at": position_at,
        "seq": seq,
        "previous": previous,
        "previous_at": previous_at,
        "previous_seq": previous_seq,
        "promotion_id": promotion_id,
    }


def _later(nxt, current):
    seen = _seq(nxt.get("seq"), "seq")
    held = _seq(current.get("seq"), "seq")
    if seen is None:
        return False
    if held is None:
        return True
    return seen > held


def advance_feedback_cursor(cursor, seen, promotion_id):
    if type(promotion_id) is not str or _blank(promotion_id):
        v.fail("invalid_input", "promotion_id must be nonempty text.")
    if cursor["promotion_id"] == promotion_id:
        return cursor
    current = {
        "id": cursor["position"],
        "recorded_at": cursor["position_at"],
        "seq": cursor["seq"],
    }
    if not _later(seen, current):
        return {
            **cursor,
            "previous": cursor["position"],
            "previous_at": cursor["position_at"],
            "previous_seq": cursor["seq"],
            "promotion_id": promotion_id,
        }
    return {
        "position": seen["id"],
        "position_at": seen["recorded_at"],
        "seq": seen["seq"],
        "previous": cursor["position"],
        "previous_at": cursor["position_at"],
        "previous_seq": cursor["seq"],
        "promotion_id": promotion_id,
    }


def rewind_feedback_cursor(cursor, promotion_id):
    if cursor["promotion_id"] != promotion_id:
        return cursor
    return {
        "position": cursor["previous"],
        "position_at": cursor["previous_at"],
        "seq": cursor["previous_seq"],
        "previous": None,
        "previous_at": None,
        "previous_seq": None,
        "promotion_id": None,
    }


def _same(left, right):
    return all(left[key] == right[key] for key in left)


def is_promotion(state, reason):
    return state == "completed" and reason in (
        "offline_pass_and_production_limits_met_not_causal_proof",
        "canary_promoted",
    )


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


def _cursor_data(cursor):
    return {
        "kind": "feedback-cursor",
        "position": cursor["position"],
        "position_at": cursor["position_at"],
        "seq": cursor["seq"],
        "previous": cursor["previous"],
        "previous_at": cursor["previous_at"],
        "previous_seq": cursor["previous_seq"],
        "promotion_id": cursor["promotion_id"],
    }


async def read_feedback_head(tx, scope):
    row = await tx.get("coordination", feedback_head_id(scope))
    if not row:
        return {"id": None, "recorded_at": None, "seq": None}
    data = row["data"]
    _stored_fields(data, ["kind", "id", "recorded_at", "seq"])
    if data["kind"] != "feedback-head":
        v.fail("invalid_state", "Feedback head kind is wrong.")
    if type(data["id"]) is not str or type(data["recorded_at"]) is not str:
        v.fail("invalid_state", "Feedback head is malformed.")
    _stored_time(data["recorded_at"], "recorded_at")
    return {
        "id": data["id"],
        "recorded_at": data["recorded_at"],
        "seq": _seq(data["seq"], "seq", True),
    }


async def promote_feedback_cursor(tx, namespace, now, scope, promotion_id, seen):
    key = feedback_cursor_id(scope)
    current = await tx.get("coordination", key)
    cursor = read_cursor(current["data"] if current else None)
    nxt = advance_feedback_cursor(cursor, seen, promotion_id)
    if not _same(cursor, nxt):
        await _write(tx, namespace, now, key, _cursor_data(nxt))
    return nxt


async def rewind_promoted_cursor(tx, namespace, now, candidate):
    scope = target_scope(candidate["target"])
    key = feedback_cursor_id(scope)
    current = await tx.get("coordination", key)
    try:
        cursor = read_cursor(current["data"] if current else None)
    except v.LoopiterError as error:
        if error.code == "invalid_state":
            return empty_feedback_cursor()
        raise
    if not cursor["promotion_id"]:
        return cursor
    run = await tx.get("runs", cursor["promotion_id"])
    selected = run["data"].get("selected_id") if run else None
    if selected != candidate["id"]:
        return cursor
    nxt = rewind_feedback_cursor(cursor, cursor["promotion_id"])
    if not _same(cursor, nxt):
        await _write(tx, namespace, now, key, _cursor_data(nxt))
    return nxt


async def persist_feedback(tx, namespace, now, parsed):
    key = feedback_record_id(parsed)
    existing = await tx.get("coordination", key)
    if existing:
        _seq(existing["data"].get("seq"), "seq", True)
        return {"id": key, "recorded_at": existing["data"]["recorded_at"]}
    scope = target_scope(parsed["target"])
    head = await read_feedback_head(tx, scope)
    seq = (head["seq"] or 0) + 1
    data = {
        "kind": "feedback",
        "answer_id": parsed["answerId"],
        "target": parsed["target"],
        "recorded_at": now,
        "seq": seq,
    }
    if "rating" in parsed:
        data["rating"] = parsed["rating"]
    if "edit" in parsed:
        data["edit"] = parsed["edit"]
    if "note" in parsed:
        data["note"] = parsed["note"]
    await _write(tx, namespace, now, key, data)
    await _write(
        tx,
        namespace,
        now,
        feedback_head_id(scope),
        {"kind": "feedback-head", "id": key, "recorded_at": now, "seq": seq},
    )
    return {"id": key, "recorded_at": now}
