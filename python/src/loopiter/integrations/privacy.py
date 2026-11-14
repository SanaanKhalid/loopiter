"""Capture redaction. Same rules as the Node capturePayload helper."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any

_CREDENTIAL_KEY = re.compile(
    r"^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|"
    r"client_secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credentials)$",
    re.IGNORECASE,
)
_PRIVATE_KEY = re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----")
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9+/_.=~-]+", re.IGNORECASE)
_BASIC = re.compile(r"\b[Bb][Aa][Ss][Ii][Cc]\s+(?![a-z]+\b)[A-Za-z0-9+/_.=~-]+")
_TOKEN = re.compile(
    r"\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b"
)
_URL_USERINFO = re.compile(r"(https?://)[^\s/@:]+:[^\s/@]+@", re.IGNORECASE)
_ASSIGNED_SECRET = re.compile(
    r"((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s&,;]+",
    re.IGNORECASE,
)


def _redact_text(value: str) -> str:
    value = _PRIVATE_KEY.sub("[REDACTED]", value)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _BASIC.sub("Basic [REDACTED]", value)
    value = _TOKEN.sub("[REDACTED]", value)
    value = _URL_USERINFO.sub(r"\1[REDACTED]@", value)
    return _ASSIGNED_SECRET.sub(r"\1[REDACTED]", value)


def redact_capture(value: Any) -> Any:
    """Pattern redaction is deliberately conservative, not a guarantee of anonymization."""
    if type(value) is str:
        return _redact_text(value)
    if type(value) is list:
        return [redact_capture(item) for item in value]
    if type(value) is dict:
        return {
            key: "[REDACTED]"
            if type(key) is str and _CREDENTIAL_KEY.fullmatch(key)
            else redact_capture(item)
            for key, item in value.items()
        }
    return value


def _json_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def capture_payload(value: Any, policy: dict[str, Any]) -> dict[str, Any]:
    maximum = policy.get("maximumBytes", policy.get("maximum_bytes", 65536))
    if type(maximum) is not int or not 128 <= maximum <= 1048576:
        raise TypeError("Capture maximumBytes must be between 128 and 1048576.")
    mode = policy.get("mode", "metadata-only")
    if mode not in ("full", "redacted", "metadata-only"):
        raise TypeError("Invalid capture mode.")
    if mode == "metadata-only":
        return {"value": {"omitted": True}, "truncated": False, "complete": False}
    custom = policy["redact"](deepcopy(value)) if policy.get("redact") else value
    clean = redact_capture(custom) if mode == "redacted" else custom
    size = _json_bytes(clean)
    if size > maximum:
        return {
            "value": {"omitted": True, "truncated": True, "bytes": size},
            "truncated": True,
            "complete": False,
        }
    return {
        "value": clean,
        "truncated": False,
        "complete": mode == "full" and not policy.get("redact"),
    }
