"""Capture redaction. Same rules as the Node capturePayload helper."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

_FLAGS = re.IGNORECASE | re.ASCII
_KEY = re.compile(
    r"^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|"
    r"client_secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credentials|"
    r"x[-_]?api[-_]?key|private[-_]?key|token)$",
    _FLAGS,
)
_PRIVATE_KEY = re.compile(
    r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)",
    re.ASCII,
)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9+/_.=~-]+", _FLAGS)
_BASIC = re.compile(r"\b[Bb][Aa][Ss][Ii][Cc]\s+(?![a-z]+\b)[A-Za-z0-9+/_.=~-]+", re.ASCII)
_TOKEN = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]{12,}|"
    r"github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|"
    r"(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b",
    re.ASCII,
)
_URL_USERINFO = re.compile(r"(https?://)[^\s/@:]+:[^\s/@]+@", _FLAGS)
_EMAIL = re.compile(
    r"(?:^|(?<=\s))[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    re.ASCII,
)
_ASSIGNED_SECRET = re.compile(
    r"((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s&,;]+",
    _FLAGS,
)
_QUERY_TOKEN = re.compile(
    r"((?:^|[\s?&#])(?:access_token|token)=)[^\s&#]+",
    _FLAGS,
)


def _redact_text(value: str) -> str:
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _BASIC.sub("Basic [REDACTED]", value)
    value = _TOKEN.sub("[REDACTED]", value)
    value = _URL_USERINFO.sub(r"\1[REDACTED]@", value)
    value = _EMAIL.sub("[REDACTED]", value)
    value = _ASSIGNED_SECRET.sub(r"\1[REDACTED]", value)
    value = _QUERY_TOKEN.sub(r"\1[REDACTED]", value)
    return _PRIVATE_KEY.sub("[REDACTED]", value)


def redact_capture(value: Any) -> Any:
    """Pattern redaction is deliberately conservative, not a guarantee of anonymization."""
    if isinstance(value, str):
        redacted = _redact_text(str(value))
        if type(value) is str:
            return redacted
        return value.__class__(redacted)
    if isinstance(value, Mapping):
        redacted = {
            key: "[REDACTED]"
            if isinstance(key, str) and _KEY.fullmatch(key)
            else redact_capture(item)
            for key, item in value.items()
        }
        if type(value) is dict:
            return redacted
        if isinstance(value, defaultdict):
            return defaultdict(value.default_factory, redacted)
        try:
            return value.__class__(redacted)
        except (TypeError, ValueError):
            return redacted
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        items = [redact_capture(item) for item in value]
        if type(value) is list:
            return items
        try:
            return value.__class__(items)
        except (TypeError, ValueError):
            return items
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
