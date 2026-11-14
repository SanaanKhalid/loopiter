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
    return _luhn_span(digits, 0, len(digits))


def _luhn_digits(digits: tuple[int, ...]) -> bool:
    total = 0
    alt = False
    for n in reversed(digits):
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def _luhn_parts(*parts: tuple[int, ...]) -> bool:
    total = 0
    alt = False
    for part in reversed(parts):
        for n in reversed(part):
            if alt:
                n *= 2
                if n > 9:
                    n -= 9
            total += n
            alt = not alt
    return total % 10 == 0


def _exact_quad(value: str, at: int, length: int) -> bool:
    return (
        at + 3 < length
        and "0" <= value[at] <= "9"
        and "0" <= value[at + 1] <= "9"
        and "0" <= value[at + 2] <= "9"
        and "0" <= value[at + 3] <= "9"
        and (at + 4 >= length or not "0" <= value[at + 4] <= "9")
    )


def _luhn_quads(value: str, pos: int) -> bool:
    """Luhn of four 4-digit groups separated by one character, starting at pos."""
    total = 0
    alt = False
    for off in (18, 17, 16, 15, 13, 12, 11, 10, 8, 7, 6, 5, 3, 2, 1, 0):
        n = ord(value[pos + off]) - 48
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def _luhn_span(value: str, start: int, end: int) -> bool:
    total = 0
    alt = False
    index = end - 1
    while index >= start:
        ch = value[index]
        if "0" <= ch <= "9":
            n = ord(ch) - 48
            if alt:
                n *= 2
                if n > 9:
                    n -= 9
            total += n
            alt = not alt
        index -= 1
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
_EXACT_LAYOUTS = frozenset(_CARD_LAYOUTS)
_LAYOUT_PREFIXES = frozenset(
    layout[:size] for layout in _CARD_LAYOUTS for size in range(1, len(layout) + 1)
)
_LONGER_PREFIXES = frozenset(
    layout[:size] for layout in _CARD_LAYOUTS for size in range(1, len(layout))
)


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
            i = j
            continue
        sep = value[j]
        pos = start
        while _exact_quad(value, pos, length) and (pos + 4 >= length or value[pos + 4] == sep):
            if (
                pos + 14 < length
                and value[pos + 4] == sep
                and value[pos + 9] == sep
                and value[pos + 14] == sep
                and _exact_quad(value, pos + 5, length)
                and _exact_quad(value, pos + 10, length)
                and _exact_quad(value, pos + 15, length)
            ):
                fifth = (
                    pos + 22 < length
                    and value[pos + 19] == sep
                    and "0" <= value[pos + 20] <= "9"
                    and "0" <= value[pos + 21] <= "9"
                    and "0" <= value[pos + 22] <= "9"
                    and (pos + 23 >= length or not "0" <= value[pos + 23] <= "9")
                )
                if fifth and _luhn_span(value, pos, pos + 23):
                    keep(pos)
                    out.append("[REDACTED]")
                    copied = pos + 23
                    pos += 24 if pos + 23 < length and value[pos + 23] == sep else 23
                    continue
                if _luhn_quads(value, pos):
                    keep(pos)
                    out.append("[REDACTED]")
                    copied = pos + 19
                    pos += 20
                    continue
                pos += 5
                continue
            break
        if pos != start:
            i = pos
            continue
        sep = value[j]
        first_digits = tuple(ord(value[p]) - 48 for p in range(start, j))
        spans: list[tuple[int, int, int, tuple[int, ...]]] = [(start, j, first, first_digits)]
        pos = j
        while (
            pos < length and value[pos] == sep and pos + 1 < length and "0" <= value[pos + 1] <= "9"
        ):
            k = pos + 1
            while k < length and "0" <= value[k] <= "9":
                k += 1
            spans.append(
                (pos + 1, k, k - (pos + 1), tuple(ord(value[p]) - 48 for p in range(pos + 1, k)))
            )
            pos = k
        group_index = 0
        while group_index < len(spans):
            group_start, group_end, group_len, group_digits = spans[group_index]
            if 13 <= group_len <= 19 and _luhn_digits(group_digits):
                keep(group_start)
                out.append("[REDACTED]")
                copied = group_end
                group_index += 1
                continue
            if (
                group_len == 4
                and group_index + 3 < len(spans)
                and spans[group_index + 1][2] == 4
                and spans[group_index + 2][2] == 4
                and spans[group_index + 3][2] == 4
            ):
                end4 = spans[group_index + 3][1]
                fifth = spans[group_index + 4] if group_index + 4 < len(spans) else None
                if (
                    fifth is not None
                    and fifth[2] == 3
                    and _luhn_parts(
                        spans[group_index][3],
                        spans[group_index + 1][3],
                        spans[group_index + 2][3],
                        spans[group_index + 3][3],
                        fifth[3],
                    )
                ):
                    matched = fifth[1]
                elif _luhn_parts(
                    spans[group_index][3],
                    spans[group_index + 1][3],
                    spans[group_index + 2][3],
                    spans[group_index + 3][3],
                ):
                    matched = end4
                else:
                    group_index += 1
                    continue
                keep(group_start)
                out.append("[REDACTED]")
                copied = matched
                while group_index < len(spans) and spans[group_index][0] < matched:
                    group_index += 1
                continue
            if group_len != 4:
                group_index += 1
                continue
            lengths: list[int] = []
            ends: list[int] = []
            total = 0
            look = group_index
            while look < len(spans) and total < 19:
                look_len = spans[look][2]
                if total + look_len > 19:
                    break
                candidate = tuple(lengths + [look_len])
                if candidate not in _LAYOUT_PREFIXES:
                    break
                lengths.append(look_len)
                ends.append(spans[look][1])
                total += look_len
                if candidate not in _LONGER_PREFIXES:
                    break
                look += 1
            matched = None
            for count in range(len(lengths), 0, -1):
                if tuple(lengths[:count]) not in _EXACT_LAYOUTS:
                    continue
                end = ends[count - 1]
                digits = "".join(ch for ch in value[group_start:end] if "0" <= ch <= "9")
                if _luhn(digits):
                    matched = end
                    break
            if matched is None:
                group_index += 1
                continue
            keep(group_start)
            out.append("[REDACTED]")
            copied = matched
            while group_index < len(spans) and spans[group_index][0] < matched:
                group_index += 1
        i = spans[-1][1]
    keep(length)
    return "".join(out) if out else value


def _redact_text(value: str) -> str:
    value = _PRIVATE_KEY.sub("[REDACTED]", value)
    value = _redact_cards(value)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _BASIC.sub("Basic [REDACTED]", value)
    value = _TOKEN.sub("[REDACTED]", value)
    value = _JWT.sub("[REDACTED]", value)
    value = _AWS_SECRET.sub(r"\1[REDACTED]", value)
    value = _ASSIGNED_SECRET.sub(r"\1[REDACTED]", value)
    value = _QUERY_TOKEN.sub(r"\1[REDACTED]", value)
    value = _redact_urls(value)
    return _redact_emails(value)


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
