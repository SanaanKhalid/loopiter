"""Strict JSON and lifecycle validation. Not a wire-format compatibility layer."""

import hashlib
import json
import math
import re
from datetime import UTC, datetime
from typing import Any

Record = dict[str, Any]
EXECUTION_KINDS = "agent turn inference prediction tool workflow retrieval custom".split()
SIGNAL_KINDS = "rating correction outcome reward approval tool_result custom".split()
TARGET_KINDS = (
    "prompt routing rule retrieval model dataset threshold tool_schema workflow "
    "agent_topology code capacity custom"
).split()
RISKS = "low medium high critical".split()
STATUSES = "proposed evaluated approved deployed rejected superseded rolled_back historical".split()
COLLECTIONS = "executions signals candidates targets attempts events".split()
EXECUTION_FIELDS = (
    "id kind episode_id parent_execution_id entity_id input output artifacts metadata "
    "started_at completed_at"
).split()
SIGNAL_FIELDS = (
    "id execution_id episode_id kind name value correction source confidence metadata observed_at"
).split()
CANDIDATE_FIELDS = "id target proposed_change evidence risk metadata".split()


class LoopiterError(Exception):
    def __init__(self, code: str, message: str, *, attempt_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.attempt_id = attempt_id


def fail(code: str, message: str) -> None:
    raise LoopiterError(code, message)


def nonempty(value: Any, name: str) -> None:
    if type(value) is not str or not value.strip() or "\0" in value:
        fail("invalid_input", f"{name} must be nonempty text without NUL.")


def enum(value: Any, allowed: list[str], name: str) -> None:
    if type(value) is not str or value not in allowed:
        fail("invalid_input", f"Invalid {name}.")


def finite(value: Any, name: str, minimum: float = -math.inf) -> None:
    if type(value) not in (int, float):
        fail("invalid_input", f"{name} must be a finite number.")
    try:
        valid = math.isfinite(value) and value >= minimum
    except OverflowError:
        valid = False
    if not valid:
        fail("invalid_input", f"Invalid {name}.")


def integer(value: Any, name: str, minimum: int = 1) -> None:
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        fail("invalid_input", f"{name} must be an integer >= {minimum}.")


def obj(value: Any, name: str = "input") -> None:
    if type(value) is not dict:
        fail("invalid_input", f"{name} must be a plain dict.")


def fields(value: Any, allowed: list[str], required: tuple[str, ...] = ()) -> None:
    obj(value)
    if set(value) - set(allowed) or set(required) - set(value):
        fail("invalid_input", "Unknown or missing required fields.")


def timestamp(value: Any, name: str = "timestamp") -> datetime:
    if type(value) is not str or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z", value
    ):
        fail("invalid_input", f"{name} must be an ISO UTC timestamp ending in Z.")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail("invalid_input", f"Invalid calendar date in {name}.")
    raise AssertionError("unreachable")


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def window_valid(window: Any) -> None:
    fields(window, ["from", "to"])
    for key, value in window.items():
        timestamp(value, key)
    if "from" in window and "to" in window and timestamp(window["from"]) >= timestamp(window["to"]):
        fail("invalid_input", "Time window must be increasing (from inclusive, to exclusive).")


def in_window(value: str, window: Record) -> bool:
    t = timestamp(value)
    return ("from" not in window or t >= timestamp(window["from"])) and (
        "to" not in window or t < timestamp(window["to"])
    )


def json_value(value: Any, maximum: int = 262144) -> None:
    seen: set[int] = set()

    def visit(v: Any, depth: int) -> None:
        if depth > 32:
            fail("invalid_input", "JSON nesting exceeds 32 levels.")
        if type(v) is str:
            if "\0" in v:
                fail("invalid_input", "NUL is not supported in JSON strings.")
            try:
                v.encode("utf-8")
            except UnicodeEncodeError:
                fail("invalid_input", "JSON strings must be valid Unicode without lone surrogates.")
            return
        if v is None or type(v) is bool:
            return
        if type(v) in (int, float):
            finite(v, "JSON number")
            return
        if type(v) not in (list, dict) or id(v) in seen:
            fail("invalid_input", "Expected acyclic plain JSON values.")
        if type(v) is dict and any(type(k) is not str for k in v):
            fail("invalid_input", "JSON keys must be strings.")
        seen.add(id(v))
        if type(v) is dict:
            for key in v:
                visit(key, depth + 1)
        for item in v.values() if type(v) is dict else v:
            visit(item, depth + 1)
        seen.remove(id(v))

    visit(value, 0)
    if len(canonical(value).encode("utf-8")) > maximum:
        fail("payload_limit", f"Payload exceeds {maximum} bytes.")


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def target(value: Any) -> None:
    fields(value, ["kind", "key"], ("kind", "key"))
    enum(value["kind"], TARGET_KINDS, "target kind")
    nonempty(value["key"], "target key")


def execution_input(value: Any) -> None:
    fields(value, EXECUTION_FIELDS, ("kind",))
    enum(value["kind"], EXECUTION_KINDS, "execution kind")
    for key in ("id", "episode_id", "parent_execution_id", "entity_id"):
        if key in value:
            nonempty(value[key], key)
    for key in ("started_at", "completed_at"):
        if key in value:
            timestamp(value[key], key)
    for key in ("metadata", "artifacts"):
        if key in value:
            obj(value[key], key)
    if "completed_at" in value and "started_at" in value:
        if timestamp(value["completed_at"]) < timestamp(value["started_at"]):
            fail("invalid_input", "Completion predates execution.")


def signal_input(value: Any) -> None:
    fields(value, SIGNAL_FIELDS, ("kind", "name", "source", "value"))
    enum(value["kind"], SIGNAL_KINDS, "signal kind")
    for key in ("name", "source", "id", "episode_id", "execution_id"):
        if key in value:
            nonempty(value[key], key)
    if not (value.get("execution_id") or value.get("episode_id")):
        fail("invalid_input", "Signal needs execution_id or episode_id.")
    if "confidence" in value:
        finite(value["confidence"], "confidence", 0)
        if value["confidence"] > 1:
            fail("invalid_input", "Confidence exceeds 1.")
    if "observed_at" in value:
        timestamp(value["observed_at"])
    if "metadata" in value:
        obj(value["metadata"], "metadata")


def candidate_input(value: Any) -> None:
    fields(value, CANDIDATE_FIELDS, ("target", "proposed_change", "evidence"))
    target(value["target"])
    if "id" in value:
        nonempty(value["id"], "id")
    if "risk" in value:
        enum(value["risk"], RISKS, "risk")
    if "metadata" in value:
        obj(value["metadata"], "metadata")


def evaluation(value: Any) -> None:
    fields(value, ["passed", "metrics", "notes"], ("passed",))
    json_value(value)
    if type(value["passed"]) is not bool:
        fail("invalid_input", "passed must be a boolean.")
    if "metrics" in value:
        obj(value["metrics"], "metrics")
        for key, number in value["metrics"].items():
            nonempty(key, "metric name")
            finite(number, key)
    if "notes" in value and type(value["notes"]) is not str:
        fail("invalid_input", "notes must be text.")


def receipt(value: Any) -> None:
    fields(
        value,
        ["attempt_id", "artifact_version", "previous_artifact_version", "metadata"],
        ("attempt_id", "artifact_version", "previous_artifact_version"),
    )
    nonempty(value["attempt_id"], "attempt_id")
    for key in ("artifact_version", "previous_artifact_version"):
        if value[key] is not None:
            nonempty(value[key], key)
    if "metadata" in value:
        obj(value["metadata"], "metadata")


def content_hash(row: Record) -> str:
    return fingerprint({k: row[k] for k in ("target", "proposed_change", "risk", "metadata")})


def stored(kind: str, row: Any, namespace: str) -> None:
    enum(kind, COLLECTIONS, "collection")
    obj(row, "adapter record")
    json_value(row, 16 * 1024 * 1024)
    nonempty(row.get("id"), "record ID")
    integer(row.get("revision"), "revision")
    if row.get("namespace") != namespace:
        fail("namespace_mismatch", "Adapter returned another namespace.")
    if timestamp(row.get("updated_at")) < timestamp(row.get("created_at")):
        fail("integrity_error", "Update predates creation.")
    if kind in ("executions", "signals", "candidates"):
        allowed, validator = {
            "executions": (EXECUTION_FIELDS, execution_input),
            "signals": (SIGNAL_FIELDS, signal_input),
            "candidates": (CANDIDATE_FIELDS, candidate_input),
        }[kind]
        validator({k: row[k] for k in allowed if k in row})
        nonempty(row.get("input_hash"), "input_hash")
        obj(row.get("metadata"), "metadata")
    if kind == "executions":
        timestamp(row.get("started_at"))
        obj(row.get("artifacts"), "artifacts")
    if kind == "signals":
        timestamp(row.get("observed_at"))
        finite(row.get("confidence"), "confidence", 0)
    if kind == "candidates":
        enum(row.get("status"), STATUSES, "candidate status")
        enum(row.get("risk"), RISKS, "risk")
        if row.get("content_hash") != content_hash(row) or row.get("evidence_hash") != fingerprint(
            row["evidence"]
        ):
            fail("integrity_error", "Candidate content/evidence hash mismatch.")
        if type(row.get("evaluations")) is not list:
            fail("integrity_error", "Invalid evaluations.")
        for e in row["evaluations"]:
            obj(e, "evaluation")
            evaluation({k: e[k] for k in ("passed", "metrics", "notes") if k in e})
            for key in ("id", "evaluator", "version", "dataset_hash"):
                nonempty(e.get(key), key)
            timestamp(e.get("created_at"))
            if (
                e.get("candidate_hash") != row["content_hash"]
                or e.get("evidence_hash") != row["evidence_hash"]
            ):
                fail("integrity_error", "Evaluation bound to different content.")
        if "approval" in row:
            a = row["approval"]
            obj(a, "approval")
            nonempty(a.get("actor"), "actor")
            timestamp(a.get("approved_at"))
            e = row["evaluations"][-1] if row["evaluations"] else {}
            if (
                not e.get("passed")
                or e.get("id") != a.get("evaluation_id")
                or a.get("candidate_hash") != row["content_hash"]
            ):
                fail("integrity_error", "Approval does not match latest passing evaluation.")
        if (
            row["status"] in ("approved", "deployed", "superseded", "rolled_back")
            and "approval" not in row
        ):
            fail("integrity_error", "Lifecycle record missing approval.")
        if "deployment_receipt" in row:
            receipt(row["deployment_receipt"])
    if kind in ("targets", "attempts"):
        target(row.get("target"))
        if kind == "targets" and row["id"] != fingerprint(row["target"]):
            fail("integrity_error", "Target identity mismatch.")
        for key in (
            "active_candidate_id",
            "pending_attempt_id",
            "restore_candidate_id",
            "previous_candidate_id",
        ):
            if key in row:
                nonempty(row[key], key)
    if kind == "targets" and row.get("artifact_version") is not None:
        nonempty(row["artifact_version"], "artifact_version")
    if kind == "attempts":
        nonempty(row.get("candidate_id"), "candidate_id")
        enum(row.get("operation"), ["apply", "rollback"], "operation")
        enum(row.get("status"), ["pending", "succeeded", "not_applied"], "attempt status")
        for key in ["expected_artifact_version"] + (
            ["restore_artifact_version"] if row["operation"] == "rollback" else []
        ):
            if key not in row:
                fail("integrity_error", "Missing artifact version.")
            if row[key] is not None:
                nonempty(row[key], key)
        if "receipt" in row:
            receipt(row["receipt"])
            if row["receipt"]["attempt_id"] != row["id"]:
                fail("integrity_error", "Attempt receipt mismatch.")
        if row["status"] == "succeeded" and "receipt" not in row:
            fail("integrity_error", "Succeeded attempt has no receipt.")
    if kind == "events":
        nonempty(row.get("type"), "event type")
        nonempty(row.get("subject_id"), "subject_id")
        obj(row.get("details"), "event details")
