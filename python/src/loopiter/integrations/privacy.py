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
_ARMOR = re.compile(
    r"-----BEGIN [^-]*PRIVATE KEY-----|-----END [^-]*PRIVATE KEY-----",
    re.ASCII,
)
_BEARER = re.compile(rf"(?<![A-Za-z0-9_])Bearer{_WS}+[A-Za-z0-9+/_.=~-]+", _FLAGS)
_BEARER_BODY = re.compile(rf"Bearer{_WS}+[A-Za-z0-9+/_.=~-]+", _FLAGS)
_BASIC = re.compile(
    rf"(?<![A-Za-z0-9_])[Bb][Aa][Ss][Ii][Cc]{_WS}+(?![a-z]+(?![A-Za-z0-9_/+.=~-]))[A-Za-z0-9+/_.=~-]+",
    re.ASCII,
)
_BASIC_BODY = re.compile(
    rf"[Bb][Aa][Ss][Ii][Cc]{_WS}+(?![a-z]+(?![A-Za-z0-9_/+.=~-]))[A-Za-z0-9+/_.=~-]+",
    re.ASCII,
)
_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|"
    r"gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|"
    r"AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9_])",
    re.ASCII,
)
_TOKEN_BODY = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]+|"
    r"gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|"
    r"AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})",
    re.ASCII,
)
_JWT = re.compile(
    r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])",
    re.ASCII,
)
_JWT_BODY = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", re.ASCII)
_JWT_EDGE = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
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


def _url_spans(value: str, spans: list[tuple[int, int, str, int]]) -> None:
    i = 0
    length = len(value)
    while i < length:
        at = value.find("://", i)
        if at < 0:
            return
        s = at - 1
        if s < i or value[s] not in _LETTERS:
            i = at + 3
            continue
        while s > i and value[s - 1] in _SCHEME:
            s -= 1
        if value[s] not in _LETTERS:
            i = at + 3
            continue
        j = at + 3
        user_start = j
        while j < length and value[j] not in _WS_SET and value[j] not in "/@:":
            j += 1
        if j == user_start or j >= length or value[j] != ":":
            i = at + 3
            continue
        j += 1
        pass_start = j
        while j < length and value[j] not in _WS_SET and value[j] not in "/@":
            j += 1
        if j == pass_start or j >= length or value[j] != "@":
            i = at + 3
            continue
        spans.append((user_start, j, "[REDACTED]", user_start))
        i = j + 1


def _email_domain_end(domain: str) -> int:
    """Longest prefix that ends in a letter label.tld, or 0."""
    best = 0
    index = 0
    limit = len(domain)
    while index < limit:
        if domain[index] != ".":
            index += 1
            continue
        tld = index + 1
        while tld < limit and domain[tld] in _LETTERS:
            tld += 1
        if index > 0 and tld - index > 2:
            best = tld
        index = tld if tld > index else index + 1
    return best


def _email_spans(
    value: str,
    spans: list[tuple[int, int, str, int]],
    blocked: list[tuple[int, int]],
    edges: set[int],
) -> None:
    i = 0
    length = len(value)
    pointer = 0
    while i < length:
        at = value.find("@", i)
        if at < 0:
            return
        left = at
        while left > i and value[left - 1] in _LOCAL:
            left -= 1
        prev = value[left - 1] if left > 0 else ""
        boundary = left == 0 or prev in _WS_SET or prev in "<(:" or left in edges
        j = at + 1
        last_dot = at
        label_has_start = False
        while j < length and value[j] in _DOMAIN:
            char = value[j]
            if char == ".":
                last_dot = j
                label_has_start = False
            elif char in "sgAGx":
                label_has_start = True
            j += 1
        prefix = _email_domain_end(value[at + 1 : j])
        end = at + 1 + prefix
        nxt = value[end] if end < length else ""
        full = prefix == j - (at + 1)
        right_blocked = full and nxt != "" and nxt.isalnum() and nxt.isascii() and end not in edges
        if left == at or not boundary or prefix == 0 or right_blocked:
            i = at + 1
            continue
        while pointer < len(blocked) and blocked[pointer][1] <= left:
            pointer += 1
        if pointer < len(blocked) and blocked[pointer][0] < end and left < blocked[pointer][1]:
            i = end
            continue
        if label_has_start and last_dot < end:
            _token_in_final_label(value, spans, last_dot + 1, end, edges)
        spans.append((left, end, "[REDACTED]", left))
        i = end


# Contiguous 13-19, or one separator and one of these group layouts.
_CARD_LAYOUTS = (
    (4, 4, 4, 4, 3),
    (4, 4, 4, 4),
    (4, 6, 5),
    (4, 6, 4),
    (4, 4, 5),
    (4, 4, 4, 3),
    (4, 4, 6),
    (8, 8),
    (4, 4, 8),
    (4, 12),
)
_EXACT_LAYOUTS = frozenset(_CARD_LAYOUTS)
_LAYOUT_PREFIXES = frozenset(
    layout[:size] for layout in _CARD_LAYOUTS for size in range(1, len(layout) + 1)
)
_MARKER = "[REDACTED]"


def _ascii_digit(ch: str) -> bool:
    return "0" <= ch <= "9"


def _luhn_ok(even: list[int], odd: list[int], start: int, end: int) -> bool:
    if end % 2 == 0:
        return (even[end] - even[start]) % 10 == 0
    return (odd[end] - odd[start]) % 10 == 0


_LUHN_DOUBLE = (0, 2, 4, 6, 8, 1, 3, 5, 7, 9)


def _luhn_span(value: str, start: int, end: int) -> bool:
    total = 0
    alt = False
    for pos in range(end - 1, start - 1, -1):
        number = ord(value[pos]) - 48
        if alt:
            number = _LUHN_DOUBLE[number]
        total += number
        alt = not alt
    return total % 10 == 0


def _card_spans(value: str, spans: list[tuple[int, int, str, int]]) -> None:
    length = len(value)
    even: list[int] | None = None
    odd: list[int] | None = None
    i = 0
    while i < length:
        if not ("0" <= value[i] <= "9"):
            i += 1
            continue
        # An isolated group shorter than 13 digits cannot be a card. Skip it
        # before allocating the run, which is the common case in mixed text.
        run_at = i
        glen = 0
        while i < length and "0" <= value[i] <= "9":
            glen += 1
            i += 1
        if not (
            (i + 1 < length and value[i] in " -" and "0" <= value[i + 1] <= "9") or 13 <= glen <= 19
        ):
            continue
        i = run_at
        starts: list[int] = []
        ends: list[int] = []
        seps: list[str] = []
        glens: list[int] = []
        gdigit = [0]
        while i < length and "0" <= value[i] <= "9":
            starts.append(i)
            glen = 0
            while i < length and "0" <= value[i] <= "9":
                glen += 1
                i += 1
            ends.append(i)
            glens.append(glen)
            gdigit.append(gdigit[-1] + glen)
            if i + 1 < length and value[i] in " -" and "0" <= value[i + 1] <= "9":
                seps.append(value[i])
                i += 1
                continue
            seps.append("")
            break
        if not any(
            13 <= glen <= 19 or ((glen == 4 or glen == 8) and sep)
            for glen, sep in zip(glens, seps, strict=True)
        ):
            continue
        if not any((glen == 4 or glen == 8) and sep for glen, sep in zip(glens, seps, strict=True)):
            for group, glen in enumerate(glens):
                if not 13 <= glen <= 19:
                    continue
                start_at = starts[group]
                group_end = ends[group]
                if start_at != 0 and _ascii_digit(value[start_at - 1]):
                    continue
                if group_end != length and _ascii_digit(value[group_end]):
                    continue
                if _luhn_span(value, start_at, group_end):
                    spans.append((start_at, group_end, _MARKER, start_at))
            continue
        if even is None or odd is None:
            even = [0] * (length + 1)
            odd = [0] * (length + 1)
        seen = 0
        for group_at, group_end in zip(starts, ends, strict=True):
            pos = group_at
            while pos < group_end:
                n = ord(value[pos]) - 48
                doubled = n * 2
                if doubled > 9:
                    doubled -= 9
                prev = seen
                seen += 1
                if prev % 2 == 0:
                    even[seen] = even[prev] + doubled
                    odd[seen] = odd[prev] + n
                else:
                    even[seen] = even[prev] + n
                    odd[seen] = odd[prev] + doubled
                pos += 1

        group = 0
        count = len(glens)
        while group < count:
            start_at = starts[group]
            if start_at != 0 and _ascii_digit(value[start_at - 1]):
                group += 1
                continue
            glen = glens[group]
            group_end = ends[group]
            if (
                13 <= glen <= 19
                and _luhn_ok(even, odd, gdigit[group], gdigit[group + 1])
                and (group_end == length or not _ascii_digit(value[group_end]))
            ):
                spans.append((start_at, group_end, _MARKER, start_at))
                group += 1
                continue
            sep = seps[group]
            if not sep or (glen != 4 and glen != 8):
                group += 1
                continue
            if (
                glen == 4
                and group + 3 < count
                and glens[group + 1] == 4
                and glens[group + 2] == 4
                and glens[group + 3] == 4
                and seps[group + 1] == sep
                and seps[group + 2] == sep
            ):
                matched = 0
                base = gdigit[group]
                if (
                    group + 4 < count
                    and glens[group + 4] == 3
                    and seps[group + 3] == sep
                    and _luhn_ok(even, odd, base, gdigit[group + 5])
                    and (ends[group + 4] == length or not _ascii_digit(value[ends[group + 4]]))
                ):
                    matched = 5
                elif _luhn_ok(even, odd, base, gdigit[group + 4]) and (
                    ends[group + 3] == length or not _ascii_digit(value[ends[group + 3]])
                ):
                    matched = 4
                if matched:
                    spans.append((start_at, ends[group + matched - 1], _MARKER, start_at))
                    group += matched
                else:
                    group += 1
                continue
            lengths = [glen]
            look = group + 1
            while look < count and seps[look - 1] == sep:
                nxt = tuple(lengths + [glens[look]])
                if nxt not in _LAYOUT_PREFIXES:
                    break
                lengths.append(glens[look])
                look += 1
            matched = 0
            base = gdigit[group]
            for size in range(len(lengths), 0, -1):
                if tuple(lengths[:size]) not in _EXACT_LAYOUTS:
                    continue
                end_group = group + size
                end_at = ends[end_group - 1]
                if _luhn_ok(even, odd, base, gdigit[end_group]) and (
                    end_at == length or not _ascii_digit(value[end_at])
                ):
                    matched = end_group
                    break
            if matched == 0:
                group += 1
                continue
            spans.append((start_at, ends[matched - 1], _MARKER, start_at))
            group = matched


def _redact_cards(value: str) -> str:
    spans: list[tuple[int, int, str, int]] = []
    _card_spans(value, spans)
    return _apply_spans(value, spans)


def _apply_spans(text: str, spans: list[tuple[int, int, str, int]]) -> str:
    if not spans:
        return text
    spans.sort(key=lambda span: (span[0], span[0] - span[1]))
    kept: list[tuple[int, int, str, int]] = []
    cover = -1
    for span in spans:
        start, end = span[0], span[1]
        if start >= end or end <= cover:
            continue
        cover = end
        kept.append(span)
    if not kept:
        return text
    parts: list[str] = []
    cursor = 0
    index = 0
    count = len(kept)
    while index < count:
        cluster = [kept[index]]
        cluster_end = kept[index][1]
        index += 1
        while index < count and kept[index][0] <= cluster_end:
            if kept[index][1] > cluster_end:
                cluster_end = kept[index][1]
            cluster.append(kept[index])
            index += 1
        cstart = cluster[0][0]
        if cursor < cstart:
            parts.append(text[cursor:cstart])
        if len(cluster) == 1:
            parts.append(cluster[0][2])
        else:
            secret = sorted((span[3], span[1]) for span in cluster)
            merged: list[tuple[int, int]] = []
            for start, end in secret:
                if merged and start <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], end))
                else:
                    merged.append((start, end))
            pos = cstart
            for start, end in merged:
                if pos < start:
                    parts.append(text[pos:start])
                parts.append(_MARKER)
                pos = end
            if pos < cluster_end:
                parts.append(text[pos:cluster_end])
        cursor = cluster_end
    if cursor < len(text):
        parts.append(text[cursor:])
    return "".join(parts)


def _token_start(value: str, end: int) -> int:
    secret = end
    while (
        secret > 0
        and value[secret - 1]
        in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_.=~-"
    ):
        secret -= 1
    return secret


def _span_edges(spans: list[tuple[int, int, str, int]]) -> set[int]:
    edges: set[int] = set()
    for start, end, _repl, _secret in spans:
        edges.add(start)
        edges.add(end)
    return edges


def _boundary_ok(value: str, index: int, end: bool, edges: set[int]) -> bool:
    if end:
        if index == len(value) or index in edges:
            return True
        return value[index] not in _JWT_EDGE
    if index == 0 or index in edges:
        return True
    return value[index - 1] not in _JWT_EDGE


def _token_right_ok(value: str, end: int, edges: set[int]) -> bool:
    return (
        end == len(value)
        or end in edges
        or value[end] not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
    )


def _token_head(value: str, index: int) -> bool:
    head = value[index : index + 12]
    if head.startswith(("sk-", "sk_live_", "github_pat_", "AIza", "AKIA", "ASIA")):
        return True
    if len(head) >= 4 and head[:3] in {"ghp", "gho", "ghu", "ghs", "ghr"} and head[3] == "_":
        return True
    return len(head) >= 5 and head[:3] == "xox" and head[3] in "baprs" and head[4] == "-"


def _token_in_final_label(
    value: str,
    spans: list[tuple[int, int, str, int]],
    label_start: int,
    label_end: int,
    edges: set[int],
) -> None:
    pos = label_start
    while pos < label_end:
        if value[pos] in "sgAGx" and _token_head(value, pos):
            match = _TOKEN_BODY.match(value, pos)
            if match is not None and _token_right_ok(value, match.end(), edges):
                spans.append((match.start(), match.end(), _MARKER, match.start()))
                return
        pos += 1


_AKIA_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
_AIZA_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
_TOKEN_LEFT = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")


def _fixed_token_start(value: str, edge: int, edges: set[int]) -> int | None:
    if edge == 0 or value[edge - 1] not in _AIZA_CHARS:
        return None
    windows = (("AKIA", 16, _AKIA_CHARS), ("ASIA", 16, _AKIA_CHARS))
    if value[edge - 1] in _AKIA_CHARS:
        for prefix, size, alphabet in windows:
            start = edge - len(prefix) - size
            if start < 0 or not value.startswith(prefix, start):
                continue
            if any(char not in alphabet for char in value[start + len(prefix) : edge]):
                continue
            if start != 0 and start not in edges and value[start - 1] in _TOKEN_LEFT:
                continue
            return start
    start = edge - 39
    if start >= 0 and value.startswith("AIza", start):
        if all(char in _AIZA_CHARS for char in value[start + 4 : edge]) and (
            start == 0 or start in edges or value[start - 1] not in _TOKEN_LEFT
        ):
            return start
    return None


def _label_at_edge(value: str, edge: int, spans: list[tuple[int, int, str, int]]) -> int:
    bearer = _BEARER_BODY.match(value, edge)
    if bearer is not None:
        spans.append((edge, bearer.end(), "Bearer " + _MARKER, _token_start(value, bearer.end())))
        return bearer.end()
    basic = _BASIC_BODY.match(value, edge)
    if basic is not None:
        spans.append((edge, basic.end(), "Basic " + _MARKER, _token_start(value, basic.end())))
        return basic.end()
    return edge


_EDGE_HINT = re.compile(
    r"sk-|sk_live_|github_pat_|AIza|AKIA|ASIA|gh[pousr]_|xox|earer|asic",
    re.IGNORECASE,
)


def _edge_tokens_possible(value: str) -> bool:
    return _EDGE_HINT.search(value) is not None


def _token_spans_at_edges(
    value: str, spans: list[tuple[int, int, str, int]], edges: set[int]
) -> None:
    if not _edge_tokens_possible(value):
        return
    covered = {start for start, _end, _repl, _secret in spans}
    length = len(value)
    ordered = sorted(spans, key=lambda span: span[0])
    pointer = 0
    skip_until = -1
    for edge in sorted(edge for edge in edges if edge < length):
        if edge < skip_until:
            continue
        while pointer < len(ordered) and ordered[pointer][1] <= edge:
            pointer += 1
        if pointer < len(ordered) and ordered[pointer][0] < edge < ordered[pointer][1]:
            continue
        fixed = _fixed_token_start(value, edge, edges)
        if fixed is not None and fixed not in covered:
            spans.append((fixed, edge, _MARKER, fixed))
            covered.add(fixed)
        if edge not in covered and value[edge] in "Bb":
            skip_until = max(skip_until, _label_at_edge(value, edge, spans))
            if skip_until > edge:
                covered.add(edge)
                continue
        if edge in covered or value[edge] not in "sgAGx" or not _token_head(value, edge):
            continue
        match = _TOKEN_BODY.match(value, edge)
        if match is None or not _token_right_ok(value, match.end(), edges):
            continue
        spans.append((match.start(), match.end(), _MARKER, match.start()))
        covered.add(edge)
        skip_until = max(skip_until, match.end())


def _suffix_card_spans(
    value: str, spans: list[tuple[int, int, str, int]], covers: list[tuple[int, int, str, int]]
) -> None:
    # A card suffix is only exposed by a span that begins before the digit group.
    # Digit-leading spans are cards themselves; skipping them keeps this pass off
    # the long contiguous-digit shapes.
    length = len(value)
    ordered = [
        span
        for span in covers
        if span[0] < length and not ("0" <= value[span[0]] <= "9") and span[1] > span[0]
    ]
    if not ordered:
        return
    ordered.sort(key=lambda span: span[0])
    run = 0
    for char in value:
        if "0" <= char <= "9":
            run += 1
            if run > 4:
                break
        else:
            run = 0
    else:
        return
    i = 0
    pointer = 0
    while i < length:
        if not ("0" <= value[i] <= "9"):
            i += 1
            continue
        starts: list[int] = []
        ends: list[int] = []
        seps: list[str] = []
        glens: list[int] = []
        while i < length and "0" <= value[i] <= "9":
            starts.append(i)
            glen = 0
            while i < length and "0" <= value[i] <= "9":
                glen += 1
                i += 1
            ends.append(i)
            glens.append(glen)
            if i + 1 < length and value[i] in " -" and "0" <= value[i + 1] <= "9":
                seps.append(value[i])
                i += 1
                continue
            seps.append("")
            break
        for group, glen in enumerate(glens):
            if glen <= 4:
                continue
            group_start = starts[group]
            while pointer < len(ordered) and ordered[pointer][1] <= group_start:
                pointer += 1
            if pointer >= len(ordered):
                return
            cover = ordered[pointer]
            if cover[0] >= group_start or cover[1] <= group_start:
                continue
            for lead in (4, 8, *range(13, 20)):
                if glen <= lead:
                    continue
                char_start = ends[group] - lead
                if char_start <= group_start or not (cover[0] <= char_start - 1 < cover[1]):
                    continue
                lengths = [lead]
                look = group + 1
                sep = seps[group]
                while sep and look < len(glens) and seps[look - 1] == sep:
                    nxt = tuple(lengths + [glens[look]])
                    if nxt not in _LAYOUT_PREFIXES:
                        break
                    lengths.append(glens[look])
                    look += 1
                for size in range(len(lengths), 0, -1):
                    if tuple(lengths[:size]) not in _EXACT_LAYOUTS:
                        continue
                    if size == 1:
                        end_at = char_start + lead
                    else:
                        end_at = ends[group + size - 1]
                    if end_at != length and _ascii_digit(value[end_at]):
                        continue
                    digits = [
                        ord(value[pos]) - 48
                        for pos in range(char_start, ends[group])
                        if "0" <= value[pos] <= "9"
                    ]
                    for follow in range(group + 1, group + size):
                        digits.extend(
                            ord(value[pos]) - 48 for pos in range(starts[follow], ends[follow])
                        )
                    total = 0
                    alt = False
                    for number in reversed(digits):
                        if alt:
                            number *= 2
                            if number > 9:
                                number -= 9
                        total += number
                        alt = not alt
                    if total % 10 == 0:
                        spans.append((char_start, end_at, _MARKER, char_start))
                        break


def _jwt_run_end(value: str, index: int) -> int:
    length = len(value)
    while index < length and value[index] in _JWT_EDGE:
        index += 1
    return index


def _jwt_spans(value: str, spans: list[tuple[int, int, str, int]], edges: set[int]) -> None:
    covered: set[int] = set()
    for match in _JWT.finditer(value):
        spans.append((match.start(), match.end(), _MARKER, match.start()))
        covered.add(match.start())
    if "eyJ" not in value:
        return
    length = len(value)
    ordered = sorted(spans, key=lambda span: span[0])
    pointer = 0
    skip_until = -1
    for edge in sorted(edge for edge in edges if edge < length):
        if edge < skip_until:
            continue
        while pointer < len(ordered) and ordered[pointer][1] <= edge:
            pointer += 1
        if pointer < len(ordered) and ordered[pointer][0] < edge < ordered[pointer][1]:
            continue
        if edge in covered or value[edge] != "e" or not value.startswith("eyJ", edge):
            continue
        match = _JWT_BODY.match(value, edge)
        if match is None or not _boundary_ok(value, match.end(), True, edges):
            # One scan per [A-Za-z0-9_-] run, whether the body matched or not.
            skip_until = _jwt_run_end(value, edge)
            continue
        spans.append((match.start(), match.end(), _MARKER, match.start()))
        covered.add(edge)
        skip_until = match.end()


def _redact_text(value: str) -> str:
    spans: list[tuple[int, int, str, int]] = []
    for match in _PRIVATE_KEY.finditer(value):
        spans.append((match.start(), match.end(), _MARKER, match.start()))
    for match in _ARMOR.finditer(value):
        spans.append((match.start(), match.end(), _MARKER, match.start()))
    for match in _TOKEN.finditer(value):
        spans.append((match.start(), match.end(), _MARKER, match.start()))
    for match in _AWS_SECRET.finditer(value):
        label = match.start() + len(match.group(1))
        spans.append((match.start(), match.end(), match.group(1) + _MARKER, label))
    for match in _BEARER.finditer(value):
        spans.append(
            (match.start(), match.end(), "Bearer " + _MARKER, _token_start(value, match.end()))
        )
    for match in _BASIC.finditer(value):
        spans.append(
            (match.start(), match.end(), "Basic " + _MARKER, _token_start(value, match.end()))
        )
    urls: list[tuple[int, int, str, int]] = []
    _url_spans(value, urls)
    spans.extend(urls)
    _card_spans(value, spans)
    for match in _ASSIGNED_SECRET.finditer(value):
        label = match.start() + len(match.group(1))
        spans.append((match.start(), match.end(), match.group(1) + _MARKER, label))
    for match in _QUERY_TOKEN.finditer(value):
        label = match.start() + len(match.group(1))
        spans.append((match.start(), match.end(), match.group(1) + _MARKER, label))
    edges = _span_edges(spans)
    _email_spans(value, spans, [(span[0], span[1]) for span in urls], edges)
    edges = _span_edges(spans)
    _jwt_spans(value, spans, edges)
    _suffix_card_spans(value, spans, spans)
    _token_spans_at_edges(value, spans, _span_edges(spans))
    return _apply_spans(value, spans)


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
