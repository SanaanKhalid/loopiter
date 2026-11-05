"""Payload capture policy. Pattern redaction is conservative, not anonymization.

Credential-like key names match as tokens, including separators and camelCase.
URL userinfo is removed for any scheme. Application values are never mutated.
Oversized payloads are omitted whole so a partial secret is not stored.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Mapping
from typing import Literal, NotRequired, TypedDict, cast

CaptureMode = Literal["full", "redacted", "metadata-only"]
JsonPrimitive = str | int | float | bool | None
JsonValue = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]

# Token match, not the whole key: separators and camelCase still count.
_CREDENTIAL_KEY = re.compile(
    r"(?:^|[-_])(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie|password|passwd|"
    r"secret|client[-_]secret|api[-_]?key|access[-_]token|refresh[-_]token|credentials)"
    r"(?:$|[-_])",
    re.IGNORECASE | re.ASCII,
)
_PRIVATE_KEY = re.compile(
    r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----",
    re.ASCII,
)
_AUTH_SCHEME = re.compile(
    r"\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+",
    re.IGNORECASE | re.ASCII,
)
_TOKEN = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|"
    r"AKIA[0-9A-Z]{16})\b",
)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
_URL_USERINFO = re.compile(
    r"\b([A-Za-z][A-Za-z0-9+.-]*://)[^\s/@]*:[^\s/@]+@",
    re.ASCII,
)
_LABELED_SECRET = re.compile(
    r"((?:password|api[_-]?key|access[_-]?token|secret|accountkey|sharedaccesssignature)"
    r"\s*[=:]\s*)[^\s&,;]+",
    re.IGNORECASE | re.ASCII,
)
_QUERY_VALUE = re.compile(
    r"(sig(?:\s*=\s*|%3d))(.*?)(?=%26|&|#|\s|$)",
    re.IGNORECASE | re.ASCII,
)
_MAX_JSON_DEPTH = 32


class CapturePolicy(TypedDict):
    """full is explicit consent to retain payloads; telemetry is not a replay archive."""

    mode: CaptureMode
    maximum_bytes: NotRequired[int]
    # Runs before built-in redaction and size checks. Never mutate application values.
    redact: NotRequired[Callable[[JsonValue], JsonValue]]


class CaptureResult(TypedDict):
    value: JsonValue
    truncated: bool
    complete: bool


def json_text(value: JsonValue) -> str:
    """Serialize like JSON.stringify for byte limits (no ASCII escaping, no spaces)."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def json_utf8_size(value: JsonValue) -> int:
    return len(json_text(value).encode("utf-8"))


def _key_tokens(key: str) -> str:
    split = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", key)
    return re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1-\2", split)


def _credential_key(key: str) -> bool:
    return _CREDENTIAL_KEY.search(_key_tokens(key)) is not None


def _redact_text(value: str) -> str:
    value = _PRIVATE_KEY.sub("[REDACTED]", value)
    value = _AUTH_SCHEME.sub(r"\1 [REDACTED]", value)
    value = _TOKEN.sub("[REDACTED]", value)
    value = _JWT.sub("[REDACTED]", value)
    value = _URL_USERINFO.sub(r"\1[REDACTED]@", value)
    value = _LABELED_SECRET.sub(r"\1[REDACTED]", value)
    return _QUERY_VALUE.sub(r"\1[REDACTED]", value)


def redact_capture(value: JsonValue) -> JsonValue:
    """Pattern redaction is deliberately conservative, not a guarantee of anonymization."""
    return _redact(value, set())


def _redact(value: object, seen: set[int]) -> JsonValue:
    if isinstance(value, str):
        return _redact_text(value)
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
        return value
    if isinstance(value, (list, tuple)):
        seq = cast(list[object] | tuple[object, ...], value)
        if id(seq) in seen:
            raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
        seen.add(id(seq))
        try:
            return [_redact(item, seen) for item in seq]
        finally:
            seen.discard(id(seq))
    if isinstance(value, dict):
        mapping = cast(dict[object, object], value)
        if id(mapping) in seen:
            raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
        seen.add(id(mapping))
        try:
            redacted: dict[str, JsonValue] = {}
            for key, item in mapping.items():
                if not isinstance(key, str):
                    raise TypeError(
                        "Captured provider payloads must be finite, acyclic JSON values."
                    )
                redacted[key] = "[REDACTED]" if _credential_key(key) else _redact(item, seen)
            return redacted
        finally:
            seen.discard(id(mapping))
    raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")


def capture_payload(value: JsonValue, policy: CapturePolicy) -> CaptureResult:
    maximum = policy.get("maximum_bytes", 65536)
    if isinstance(maximum, bool) or type(maximum) is not int or not 128 <= maximum <= 1048576:
        raise TypeError("Capture maximum_bytes must be between 128 and 1048576.")
    if policy.get("mode") not in ("full", "redacted", "metadata-only"):
        raise TypeError("Invalid capture mode.")
    if policy["mode"] == "metadata-only":
        return {"value": {"omitted": True}, "truncated": False, "complete": False}
    redact = policy.get("redact")
    custom = redact(copy_json(value)) if redact is not None else value
    clean = redact_capture(custom) if policy["mode"] == "redacted" else custom
    size = json_utf8_size(clean)
    # Omit whole oversized payloads, never store a partially redacted secret or invalid JSON.
    if size > maximum:
        return {
            "value": {"omitted": True, "truncated": True, "bytes": size},
            "truncated": True,
            "complete": False,
        }
    return {
        "value": clean,
        "truncated": False,
        "complete": policy["mode"] == "full" and not policy.get("redact"),
    }


def copy_json(value: JsonValue) -> JsonValue:
    """Detach a JSON value before a caller-supplied redact callback."""
    return _copy_json(value, set(), 0)


def _copy_json(value: object, seen: set[int], depth: int) -> JsonValue:
    if depth > _MAX_JSON_DEPTH:
        raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, list):
        items = cast(list[object], value)
        if id(items) in seen:
            raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
        seen.add(id(items))
        try:
            return [_copy_json(item, seen, depth + 1) for item in items]
        finally:
            seen.discard(id(items))
    if isinstance(value, dict):
        mapping = cast(dict[object, object], value)
        if id(mapping) in seen:
            raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
        seen.add(id(mapping))
        try:
            copied: dict[str, JsonValue] = {}
            for key, item in mapping.items():
                if not isinstance(key, str):
                    raise TypeError(
                        "Captured provider payloads must be finite, acyclic JSON values."
                    )
                copied[key] = _copy_json(item, seen, depth + 1)
            return copied
        finally:
            seen.discard(id(mapping))
    raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")


def checked_policy(capture: object = None) -> CapturePolicy:
    """Merge the metadata-only default and reject an invalid mode or maximum_bytes."""
    merged: dict[str, object] = {"mode": "metadata-only"}
    if capture is not None:
        if not isinstance(capture, Mapping):
            raise TypeError("Invalid capture mode.")
        merged.update(cast(Mapping[str, object], capture))
    policy = cast(CapturePolicy, merged)
    capture_payload(None, policy)
    return policy


__all__ = [
    "CaptureMode",
    "CapturePolicy",
    "CaptureResult",
    "JsonValue",
    "capture_payload",
    "checked_policy",
    "copy_json",
    "json_text",
    "json_utf8_size",
    "redact_capture",
]
