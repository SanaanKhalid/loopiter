"""Capture redaction. Same rules as the Node capturePayload helper."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

# Shared with src/integrations/privacy.ts. Listed explicitly:
# U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR, U+0020 SPACE,
# U+0085 NEXT LINE, U+00A0 NO-BREAK SPACE, U+1680 OGHAM SPACE MARK,
# U+180E MONGOLIAN VOWEL SEPARATOR,
# U+2000 EN QUAD, U+2001 EM QUAD, U+2002 EN SPACE, U+2003 EM SPACE,
# U+2004 THREE-PER-EM SPACE, U+2005 FOUR-PER-EM SPACE, U+2006 SIX-PER-EM SPACE,
# U+2007 FIGURE SPACE, U+2008 PUNCTUATION SPACE, U+2009 THIN SPACE, U+200A HAIR SPACE,
# U+200B ZERO WIDTH SPACE,
# U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, U+202F NARROW NO-BREAK SPACE,
# U+205F MEDIUM MATHEMATICAL SPACE, U+3000 IDEOGRAPHIC SPACE, U+FEFF BOM.
_WS_CHARS = (
    "\t\n\v\f\r \u0085\u00a0\u1680\u180e"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WS_SET = frozenset(_WS_CHARS)
# U+180E and U+200B may separate a label from a value. They do not end the value.
_FORMAT_WS = "\u180e\u200b"
_VALUE_BREAK = "".join(ch for ch in _WS_CHARS if ch not in _FORMAT_WS)
_WS = f"[{_WS_CHARS}]"
_FLAGS = re.IGNORECASE | re.ASCII
_KEY = re.compile(
    r"^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|"
    r"client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credentials|"
    r"x[-_]?api[-_]?key|private[-_]?key|token|session)$",
    _FLAGS,
)
_PRIVATE_KEY = re.compile(
    r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|\Z)",
    re.ASCII,
)
_BEARER = re.compile(rf"(?<![A-Za-z0-9_])Bearer{_WS}+[A-Za-z0-9+/_.=~-]+", _FLAGS)
_BASIC = re.compile(
    rf"(?<![A-Za-z0-9_])[Bb][Aa][Ss][Ii][Cc]{_WS}+(?![a-z]+(?![A-Za-z0-9_]))[A-Za-z0-9+/_.=~-]+",
    re.ASCII,
)
_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|"
    r"gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|"
    r"AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9_])",
    re.ASCII,
)
_JWT = re.compile(
    r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])",
    re.ASCII,
)
_AWS_SECRET = re.compile(
    rf"(?<![A-Za-z0-9])([\"']?(?:aws[-_]?)?secret[-_]?access[-_]?key[\"']?{_WS}*[=:]{_WS}*[\"']?)"
    r"[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])",
    _FLAGS,
)
_ASSIGNED_SECRET = re.compile(
    rf"((?:password|api[_-]?key|access[_-]?token|secret){_WS}*[=:]{_WS}*)[^{_VALUE_BREAK}&,;]+",
    _FLAGS,
)
_QUERY_TOKEN = re.compile(
    rf"((?:^|[{_WS_CHARS}?&#])(?:access_token|token)=)[^{_VALUE_BREAK}&#]+",
    _FLAGS,
)
_LOCAL = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._%+-")
_DOMAIN = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-")
_SCHEME = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+.-")
_LETTERS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


def json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _redact_urls(value: str) -> str:
    out: list[str] = []
    i = 0
    length = len(value)
    while i < length:
        at = value.find("://", i)
        if at < 0:
            out.append(value[i:])
            break
        s = at - 1
        if s < i or value[s] not in _LETTERS:
            out.append(value[i : at + 3])
            i = at + 3
            continue
        while s > i and value[s - 1] in _SCHEME:
            s -= 1
        if value[s] not in _LETTERS:
            out.append(value[i : at + 3])
            i = at + 3
            continue
        j = at + 3
        user_start = j
        while j < length and value[j] not in _WS_SET and value[j] not in "/@:":
            j += 1
        if j == user_start or j >= length or value[j] != ":":
            out.append(value[i : at + 3])
            i = at + 3
            continue
        j += 1
        pass_start = j
        while j < length and value[j] not in _WS_SET and value[j] not in "/@":
            j += 1
        if j == pass_start or j >= length or value[j] != "@":
            out.append(value[i : at + 3])
            i = at + 3
            continue
        out.append(value[i:s] + value[s:at] + "://[REDACTED]@")
        i = j + 1
    return "".join(out)


def _redact_emails(value: str) -> str:
    out: list[str] = []
    i = 0
    length = len(value)
    while i < length:
        at = value.find("@", i)
        if at < 0:
            out.append(value[i:])
            break
        left = at
        while left > i and value[left - 1] in _LOCAL:
            left -= 1
        prev = value[left - 1] if left > 0 else ""
        boundary = left == 0 or prev in _WS_SET or prev in "<(:"
        j = at + 1
        while j < length and value[j] in _DOMAIN:
            j += 1
        domain = value[at + 1 : j]
        dot = domain.rfind(".")
        tld = domain[dot + 1 :] if dot >= 0 else ""
        nxt = value[j] if j < length else ""
        if (
            left == at
            or not boundary
            or dot <= 0
            or len(tld) < 2
            or any(ch not in _LETTERS for ch in tld)
            or (nxt != "" and nxt.isalnum() and nxt.isascii())
        ):
            out.append(value[i : at + 1])
            i = at + 1
            continue
        out.append(value[i:left] + "[REDACTED]")
        i = j
    return "".join(out)


def _luhn(digits: str) -> bool:
    total = 0
    alt = False
    for ch in reversed(digits):
        n = ord(ch) - 48
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def _ascii_digit(ch: str) -> bool:
    return "0" <= ch <= "9"


_CARD_LAYOUTS = (
    (4, 4, 4, 4),
    (4, 4, 4, 4, 3),
    (4, 6, 5),
    (4, 6, 4),
    (4, 4, 5),
    (4, 4, 4, 3),
    (4, 4, 6),
)


def _layout_prefix(groups: tuple[int, ...]) -> bool:
    return any(layout[: len(groups)] == groups for layout in _CARD_LAYOUTS)


def _longer_layout(groups: tuple[int, ...]) -> bool:
    return any(
        len(layout) > len(groups) and layout[: len(groups)] == groups for layout in _CARD_LAYOUTS
    )


def _exact_layout(groups: tuple[int, ...]) -> bool:
    return groups in _CARD_LAYOUTS


def _next_card_group(value: str, start: int) -> int:
    """Index of the next digit group after start, or the end of this group."""
    j = start
    length = len(value)
    while j < length and _ascii_digit(value[j]):
        j += 1
    if j < length and value[j] in " -" and j + 1 < length and _ascii_digit(value[j + 1]):
        return j + 1
    return j


def _redact_cards(value: str) -> str:
    out: list[str] = []
    i = 0
    copied = 0
    length = len(value)

    def keep(end: int) -> None:
        nonlocal copied
        if copied < end:
            out.append(value[copied:end])
            copied = end

    while i < length:
        ch = value[i]
        if not ("0" <= ch <= "9") or (i > 0 and "0" <= value[i - 1] <= "9"):
            i += 1
            continue
        start = i
        j = i + 1
        while j < length and "0" <= value[j] <= "9":
            j += 1
        first = j - start
        grouped = j + 1 < length and value[j] in " -" and "0" <= value[j + 1] <= "9"
        if first != 4:
            if not grouped:
                if 13 <= first <= 19 and _luhn(value[start:j]):
                    keep(start)
                    out.append("[REDACTED]")
                    copied = j
                i = j
                continue
            i = j + 1
            continue
        if not grouped:
            if 13 <= first <= 19 and _luhn(value[start:j]):
                keep(start)
                out.append("[REDACTED]")
                copied = j
            i = j
            continue
        if not _layout_prefix((first,)):
            i = _next_card_group(value, start)
            continue
        groups = [first]
        total = first
        sep = value[j]
        while (
            j < length
            and value[j] == sep
            and j + 1 < length
            and _ascii_digit(value[j + 1])
            and _longer_layout(tuple(groups))
        ):
            k = j + 1
            nxt = 0
            while k < length and _ascii_digit(value[k]):
                nxt += 1
                k += 1
            if total + nxt > 19 or not _layout_prefix((*groups, nxt)):
                break
            total += nxt
            groups.append(nxt)
            j = k
        while j > start and value[j - 1] in " -":
            j -= 1
        digits = "".join(ch for ch in value[start:j] if _ascii_digit(ch))
        if _exact_layout(tuple(groups)) and _luhn(digits):
            keep(start)
            out.append("[REDACTED]")
            copied = j
            i = j
            continue
        i = _next_card_group(value, start)
    keep(length)
    return "".join(out) if out else value


def _redact_text(value: str) -> str:
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _BASIC.sub("Basic [REDACTED]", value)
    value = _TOKEN.sub("[REDACTED]", value)
    value = _JWT.sub("[REDACTED]", value)
    value = _AWS_SECRET.sub(r"\1[REDACTED]", value)
    value = _ASSIGNED_SECRET.sub(r"\1[REDACTED]", value)
    value = _QUERY_TOKEN.sub(r"\1[REDACTED]", value)
    value = _PRIVATE_KEY.sub("[REDACTED]", value)
    value = _redact_urls(value)
    value = _redact_emails(value)
    return _redact_cards(value)


def redact_capture(value: Any, patterns: bool = True) -> Any:
    """Pattern redaction is deliberately conservative, not a guarantee of anonymization."""
    if isinstance(value, str):
        if not patterns:
            return value
        redacted = _redact_text(str(value))
        if type(value) is str:
            return redacted
        return value.__class__(redacted)
    if isinstance(value, Mapping):
        redacted = {
            key: "[REDACTED]"
            if isinstance(key, str) and _KEY.fullmatch(key)
            else redact_capture(item, patterns)
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
        items = [redact_capture(item, patterns) for item in value]
        if type(value) is list:
            return items
        try:
            return value.__class__(items)
        except (TypeError, ValueError):
            return items
    return value


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
    prepared = redact_capture(custom, patterns=False) if mode == "redacted" else custom
    prepared_size = json_size(prepared)
    if mode == "redacted" and prepared_size > maximum:
        return {
            "value": {"omitted": True, "truncated": True, "bytes": prepared_size},
            "truncated": True,
            "complete": False,
        }
    clean = redact_capture(prepared, patterns=True) if mode == "redacted" else prepared
    size = json_size(clean)
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
