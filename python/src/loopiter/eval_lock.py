"""Deterministic eval-set lock and exact train/eval overlap check.

Scheme 1 hashes canonical JSON. Item order and object key order do not change
the digest. The leakage check is exact after NFC and whitespace normalization.
It does not fuzzy-match and it does not call user code.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

from . import _validation as v

EVAL_LOCK_SCHEME = 1
EVAL_REPORT_ID_CAP = 20
_SAFE_INTEGER_MAX = 9007199254740991
_CONTENT_FIELDS = ("input", "expected")
_WS_CHARS = (
    "\t\n\v\f\r \u00a0\u1680"
    + "".join(chr(code) for code in range(0x2000, 0x200B))
    + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def lock_eval_set(suite: Any) -> dict[str, Any]:
    return _lock_items(read_eval_suite(suite)["items"])


def verify_eval_lock(suite: Any, lock: Any) -> dict[str, Any]:
    current = lock_eval_set(suite)
    expected = read_eval_lock(lock)
    previous = {item["id"]: item["sha256"] for item in expected["items"]}
    nxt = {item["id"]: item["sha256"] for item in current["items"]}
    added_ids = sorted((item for item in nxt if item not in previous), key=_utf8)
    removed_ids = sorted((item for item in previous if item not in nxt), key=_utf8)
    changed_ids = sorted(
        (item for item in nxt if item in previous and previous[item] != nxt[item]),
        key=_utf8,
    )
    added, added_cut = _cap_ids(added_ids)
    removed, removed_cut = _cap_ids(removed_ids)
    changed, changed_cut = _cap_ids(changed_ids)
    same = (
        current["sha256"] == expected["sha256"]
        and not added_ids
        and not removed_ids
        and not changed_ids
    )
    return {
        "ok": same,
        "scheme": EVAL_LOCK_SCHEME,
        "itemCount": current["itemCount"],
        "sha256": current["sha256"],
        "added": len(added_ids),
        "removed": len(removed_ids),
        "changed": len(changed_ids),
        "truncated": added_cut or removed_cut or changed_cut,
        "addedIds": added,
        "removedIds": removed,
        "changedIds": changed,
    }


def check_eval_leakage(
    train: Any, evaluation: Any, fields: list[str] | tuple[str, ...] | None = None
) -> dict[str, Any]:
    train_items = read_eval_suite(train)["items"]
    eval_items = read_eval_suite(evaluation)["items"]
    selected = _read_fields(["input", "expected"] if fields is None else list(fields))
    train_ids = {item["id"] for item in train_items}
    hashes: dict[str, list[str]] = {}
    for item in train_items:
        hashes.setdefault(_content_hash(item, selected), []).append(item["id"])
    id_overlap: set[str] = set()
    content_overlap: set[str] = set()
    for item in eval_items:
        if item["id"] in train_ids:
            id_overlap.add(item["id"])
        matched = hashes.get(_content_hash(item, selected))
        if not matched:
            continue
        content_overlap.add(item["id"])
        content_overlap.update(matched)
    ids = sorted(id_overlap | content_overlap, key=_utf8)
    capped, truncated = _cap_ids(ids)
    return {
        "ok": not ids,
        "trainItems": len(train_items),
        "evalItems": len(eval_items),
        "overlapCount": len(ids),
        "idOverlapCount": len(id_overlap),
        "contentOverlapCount": len(content_overlap),
        "truncated": truncated,
        "ids": capped,
    }


def read_eval_suite(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or "items" not in value or not isinstance(value["items"], list):
        v.fail("invalid_input", "Eval set must be an object with an items array.")
    items = [_read_eval_item(item) for item in value["items"]]
    seen: set[str] = set()
    for item in items:
        if item["id"] in seen:
            v.fail("invalid_input", f"Eval set has a duplicate id: {quote_ascii(item['id'])}")
        seen.add(item["id"])
    return {"items": items}


def read_eval_lock(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or "scheme" not in value:
        v.fail("eval_lock_invalid", "Lock file is not an eval lock.")
    if value["scheme"] != EVAL_LOCK_SCHEME:
        v.fail("eval_lock_invalid", "Lock file uses an unsupported scheme.")
    count = value.get("itemCount")
    if type(count) is float and count.is_integer() and abs(count) <= _SAFE_INTEGER_MAX:
        count = int(count)
    digest = value.get("sha256")
    items = value.get("items")
    if (
        type(count) is not int
        or count < 0
        or not isinstance(digest, str)
        or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        or not isinstance(items, list)
        or len(items) != count
    ):
        v.fail("eval_lock_invalid", "Lock file is not an eval lock.")
    locked = [_read_lock_item(item) for item in items]
    for index in range(1, len(locked)):
        if _utf8(locked[index - 1]["id"]) >= _utf8(locked[index]["id"]):
            v.fail("eval_lock_invalid", "Lock file is not an eval lock.")
    return {"scheme": EVAL_LOCK_SCHEME, "itemCount": count, "sha256": digest, "items": locked}


def default_lock_path(suite_path: str) -> str:
    if suite_path.endswith(".json"):
        return suite_path[:-5] + ".lock.json"
    return suite_path + ".lock.json"


def quote_ascii(value: str) -> str:
    text = json.dumps(value, ensure_ascii=True)
    return "".join(
        "\\u" + format(ord(char), "04x") if ord(char) < 0x20 or ord(char) > 0x7E else char
        for char in text
    )


def ascii_json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True)


def format_lock_wrote(path: str, lock: dict[str, Any]) -> str:
    return (
        f"eval lock wrote {quote_ascii(path)} scheme {lock['scheme']} "
        f"items {lock['itemCount']} sha256 {lock['sha256']}\n"
    )


def format_lock_text(report: dict[str, Any]) -> str:
    if report["ok"]:
        return (
            f"eval lock ok scheme {report['scheme']} items {report['itemCount']} "
            f"sha256 {report['sha256']}\n"
        )
    return (
        f"eval lock drift added {report['added']} removed {report['removed']} "
        f"changed {report['changed']} truncated {str(report['truncated']).lower()} "
        f"addedIds {_ascii_compact(report['addedIds'])} "
        f"removedIds {_ascii_compact(report['removedIds'])} "
        f"changedIds {_ascii_compact(report['changedIds'])}\n"
    )


def format_lock_json(report: dict[str, Any]) -> str:
    return ascii_json(report) + "\n"


def format_leakage_text(report: dict[str, Any]) -> str:
    if report["ok"]:
        return (
            f"eval leakage ok train {report['trainItems']} eval {report['evalItems']} overlaps 0\n"
        )
    return (
        f"eval leakage overlap count {report['overlapCount']} "
        f"truncated {str(report['truncated']).lower()} ids {_ascii_compact(report['ids'])}\n"
    )


def format_leakage_json(report: dict[str, Any]) -> str:
    return ascii_json(report) + "\n"


def assert_safe_json_text(text: str) -> None:
    index = 0
    length = len(text)
    while index < length:
        character = text[index]
        if character == '"':
            index += 1
            while index < length:
                if text[index] == "\\":
                    index += 2
                    continue
                if text[index] == '"':
                    index += 1
                    break
                index += 1
            continue
        if character == "-" or "0" <= character <= "9":
            start = index
            if text[index] == "-":
                index += 1
            digits = index
            while index < length and "0" <= text[index] <= "9":
                index += 1
            integer_end = index
            decimal = False
            if index < length and text[index] == ".":
                decimal = True
                index += 1
                while index < length and "0" <= text[index] <= "9":
                    index += 1
            if index < length and text[index] in "eE":
                decimal = True
                index += 1
                if index < length and text[index] in "+-":
                    index += 1
                while index < length and "0" <= text[index] <= "9":
                    index += 1
            if (
                not decimal
                and integer_end > digits
                and _unsafe_integer_token(text[start:integer_end])
            ):
                v.fail("invalid_input", "Eval set contains an integer outside the safe range.")
            if index == start:
                index += 1
            continue
        index += 1


def run_eval_command(args: list[str]) -> int:
    try:
        return _dispatch_eval(args)
    except _Usage as error:
        return error.code
    except v.LoopiterError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        print(str(error) if str(error) else "Eval command failed.", file=sys.stderr)
        return 1


class _Usage(Exception):
    def __init__(self, code: int):
        super().__init__("usage")
        self.code = code


def _dispatch_eval(args: list[str]) -> int:
    if not args:
        return _usage("Usage: loopiter eval lock|verify|leakage")
    sub = args[0]
    if sub == "lock":
        return _command_lock(args[1:])
    if sub == "verify":
        return _command_verify(args[1:])
    if sub == "leakage":
        return _command_leakage(args[1:])
    if sub.startswith("--"):
        return _usage(f"Unknown option: {sub}")
    return _usage(f"Unknown eval command: {sub}")


def _command_lock(args: list[str]) -> int:
    parsed = _parse_args(args, ["--out"], [])
    if len(parsed["positionals"]) != 1:
        return _usage("Usage: loopiter eval lock <suite> [--out <path>]")
    suite_path = parsed["positionals"][0]
    out = parsed["values"].get("--out", default_lock_path(suite_path))
    lock = lock_eval_set(_read_json(suite_path))
    Path(out).write_text(ascii_json(lock) + "\n", encoding="utf-8")
    sys.stdout.write(format_lock_wrote(out, lock))
    return 0


def _command_verify(args: list[str]) -> int:
    parsed = _parse_args(args, ["--lock"], ["--json"])
    if len(parsed["positionals"]) != 1:
        return _usage("Usage: loopiter eval verify <suite> [--lock <path>] [--json]")
    suite_path = parsed["positionals"][0]
    lock_path = parsed["values"].get("--lock", default_lock_path(suite_path))
    report = verify_eval_lock(_read_json(suite_path), _read_json(lock_path))
    sys.stdout.write(
        format_lock_json(report) if "--json" in parsed["switches"] else format_lock_text(report)
    )
    return 0 if report["ok"] else 1


def _command_leakage(args: list[str]) -> int:
    parsed = _parse_args(args, ["--train", "--eval", "--fields"], ["--json"])
    if parsed["positionals"]:
        return _usage(
            "Usage: loopiter eval leakage --train <file> --eval <file> [--fields <names>] [--json]"
        )
    if "--train" not in parsed["values"] or "--eval" not in parsed["values"]:
        return _usage(
            "Usage: loopiter eval leakage --train <file> --eval <file> [--fields <names>] [--json]"
        )
    fields = (
        None if "--fields" not in parsed["values"] else _split_fields(parsed["values"]["--fields"])
    )
    report = check_eval_leakage(
        _read_json(parsed["values"]["--train"]),
        _read_json(parsed["values"]["--eval"]),
        fields,
    )
    sys.stdout.write(
        format_leakage_json(report)
        if "--json" in parsed["switches"]
        else format_leakage_text(report)
    )
    return 0 if report["ok"] else 1


def _split_fields(value: str) -> list[str]:
    if value == "":
        v.fail("invalid_input", "--fields requires a value.")
    return value.split(",")


def _parse_args(args: list[str], values: list[str], switches: list[str]) -> dict[str, Any]:
    seen: set[str] = set()
    positionals: list[str] = []
    parsed: dict[str, str] = {}
    found: set[str] = set()
    index = 0
    while index < len(args):
        option = args[index]
        if option.startswith("--"):
            if option in seen:
                _stop(f"Duplicate option: {option}")
            seen.add(option)
            if option in switches:
                found.add(option)
                index += 1
                continue
            if option not in values:
                _stop(f"Unknown option: {option}")
            if index + 1 >= len(args) or args[index + 1].startswith("--"):
                _stop(f"{option} requires a value.")
            parsed[option] = args[index + 1]
            index += 2
            continue
        positionals.append(option)
        index += 1
    return {"positionals": positionals, "values": parsed, "switches": found}


def _stop(message: str) -> None:
    print(message, file=sys.stderr)
    raise _Usage(2)


def _usage(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


def _read_json(path: str) -> Any:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        v.fail("invalid_input", f"Missing file: {quote_ascii(path)}")
    except OSError:
        v.fail("invalid_input", f"File is not JSON: {quote_ascii(path)}")
    try:
        assert_safe_json_text(text)
        return json.loads(text)
    except v.LoopiterError:
        raise
    except (json.JSONDecodeError, UnicodeError):
        v.fail("invalid_input", f"File is not JSON: {quote_ascii(path)}")


def _lock_items(items: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(items, key=lambda item: _utf8(item["id"]))
    locked = [
        {"id": item["id"], "sha256": _sha256(_canonical_json(_item_record(item)))}
        for item in ordered
    ]
    return {
        "scheme": EVAL_LOCK_SCHEME,
        "itemCount": len(locked),
        "sha256": _sha256(_canonical_json([_item_record(item) for item in ordered])),
        "items": locked,
    }


def _item_record(item: dict[str, Any]) -> dict[str, Any]:
    return {"expected": item["expected"], "id": item["id"], "input": item["input"]}


def _read_eval_item(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        v.fail("invalid_input", "Eval item must be an object.")
    for key in value:
        if key not in ("id", "input", "expected"):
            v.fail("invalid_input", "Eval item has an unknown field.")
    item_id = value.get("id")
    if not isinstance(item_id, str) or not item_id.strip() or "\0" in item_id:
        v.fail("invalid_input", "Eval item id must be a nonempty string.")
    if "input" not in value:
        v.fail("invalid_input", "Eval item is missing input.")
    if "expected" not in value:
        v.fail("invalid_input", "Eval item is missing expected.")
    return {
        "id": item_id,
        "input": _json_value(value["input"]),
        "expected": _json_value(value["expected"]),
    }


def _read_lock_item(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        v.fail("eval_lock_invalid", "Lock file is not an eval lock.")
    item_id = value.get("id")
    digest = value.get("sha256")
    if (
        not isinstance(item_id, str)
        or not item_id.strip()
        or "\0" in item_id
        or not isinstance(digest, str)
        or re.fullmatch(r"[0-9a-f]{64}", digest) is None
    ):
        v.fail("eval_lock_invalid", "Lock file is not an eval lock.")
    return {"id": item_id, "sha256": digest}


def _read_fields(fields: list[str]) -> list[str]:
    if not fields:
        v.fail("invalid_input", "--fields requires a value.")
    seen: set[str] = set()
    for field in fields:
        if field not in _CONTENT_FIELDS:
            v.fail("invalid_input", f"Unknown field: {quote_ascii(field)}")
        if field in seen:
            v.fail("invalid_input", f"Duplicate field: {quote_ascii(field)}")
        seen.add(field)
    return list(fields)


def _content_hash(item: dict[str, Any], fields: list[str]) -> str:
    payload = {field: _normalize_value(item[field]) for field in fields}
    return _sha256(_canonical_json(payload))


def _normalize_value(value: Any) -> Any:
    if isinstance(value, str):
        return _normalize_text(value)
    if isinstance(value, list):
        return [_normalize_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_value(item) for key, item in value.items()}
    return value


def _normalize_text(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        v.fail("invalid_input", "Eval set contains invalid Unicode.")
    collapsed = []
    pending = False
    for character in unicodedata.normalize("NFC", value):
        if character in _WS_CHARS:
            pending = True
            continue
        if pending and collapsed:
            collapsed.append(" ")
        pending = False
        collapsed.append(character)
    return "".join(collapsed)


def _cap_ids(ids: list[str]) -> tuple[list[str], bool]:
    if len(ids) <= EVAL_REPORT_ID_CAP:
        return ids, False
    return ids[:EVAL_REPORT_ID_CAP], True


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _ascii_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def _utf8(value: str) -> bytes:
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError:
        v.fail("invalid_input", "Eval set contains invalid Unicode.")


def _unsafe_integer_token(token: str) -> bool:
    digits = token[1:] if token.startswith("-") else token
    digits = digits.lstrip("0") or "0"
    if not digits.isdigit():
        return False
    if len(digits) > len(str(_SAFE_INTEGER_MAX)):
        return True
    if len(digits) < len(str(_SAFE_INTEGER_MAX)):
        return False
    return digits > str(_SAFE_INTEGER_MAX)


def _canonical_json(value: Any) -> str:
    return _encode_json(_json_value(value), set())


def _json_value(value: Any, seen: set[int] | None = None) -> Any:
    if seen is None:
        seen = set()
    if value is None or type(value) is bool or isinstance(value, str):
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                v.fail("invalid_input", "Eval set contains invalid Unicode.")
        return value
    if type(value) is int:
        if abs(value) > _SAFE_INTEGER_MAX:
            v.fail("invalid_input", "Eval set contains an integer outside the safe range.")
        return value
    if type(value) is float:
        if not math.isfinite(value):
            v.fail("invalid_input", "Eval set contains a non-finite number.")
        return value
    if type(value) is list:
        if id(value) in seen:
            v.fail("invalid_input", "Eval set contains a value that is not JSON.")
        seen.add(id(value))
        copied = [_json_value(item, seen) for item in value]
        seen.remove(id(value))
        return copied
    if type(value) is dict:
        if id(value) in seen or any(not isinstance(key, str) for key in value):
            v.fail("invalid_input", "Eval set contains a value that is not JSON.")
        seen.add(id(value))
        copied = {key: _json_value(item, seen) for key, item in value.items()}
        seen.remove(id(value))
        return copied
    v.fail("invalid_input", "Eval set contains a value that is not JSON.")


def _encode_json(value: Any, seen: set[int]) -> str:
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if isinstance(value, str):
        return _canonical_string(value)
    if type(value) in (int, float):
        return _canonical_number(value)
    if type(value) is list:
        if id(value) in seen:
            v.fail("invalid_input", "Eval set contains a value that is not JSON.")
        seen.add(id(value))
        text = "[" + ",".join(_encode_json(item, seen) for item in value) + "]"
        seen.remove(id(value))
        return text
    if id(value) in seen:
        v.fail("invalid_input", "Eval set contains a value that is not JSON.")
    seen.add(id(value))
    keys = sorted(value, key=_utf8)
    text = (
        "{"
        + ",".join(_canonical_string(key) + ":" + _encode_json(value[key], seen) for key in keys)
        + "}"
    )
    seen.remove(id(value))
    return text


def _canonical_number(value: int | float) -> str:
    if type(value) is bool:
        v.fail("invalid_input", "Eval set contains a value that is not JSON.")
    if type(value) is int:
        return str(value)
    if not math.isfinite(value) or type(value) is not float:
        v.fail("invalid_input", "Eval set contains a non-finite number.")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) <= _SAFE_INTEGER_MAX:
        return str(int(value))
    return _es_number(json.dumps(value, allow_nan=False))


def _es_number(text: str) -> str:
    sign, digits, exponent = _number_parts(text)
    if exponent < -6 or exponent > 20:
        body = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
        sign_exp = "+" if exponent > 0 else "-"
        return sign + body + "e" + sign_exp + str(abs(exponent))
    if exponent >= 0:
        if exponent >= len(digits) - 1:
            return sign + digits + ("0" * (exponent - (len(digits) - 1)))
        return sign + digits[: exponent + 1] + "." + digits[exponent + 1 :]
    return sign + "0." + ("0" * (-exponent - 1)) + digits


def _number_parts(text: str) -> tuple[str, str, int]:
    sign = ""
    if text.startswith("-"):
        sign = "-"
        text = text[1:]
    exponent = 0
    lowered = text.lower()
    if "e" in lowered:
        mantissa, exponent_text = lowered.split("e", 1)
        exponent = int(exponent_text)
    else:
        mantissa = text
    whole, fraction = mantissa.split(".", 1) if "." in mantissa else (mantissa, "")
    raw = whole + fraction
    if raw.strip("0") == "":
        return sign, "0", 0
    power = exponent - len(fraction)
    stripped = raw.lstrip("0")
    trailing = len(stripped) - len(stripped.rstrip("0"))
    digits = stripped.rstrip("0")
    first = power + trailing + len(digits) - 1
    return sign, digits, first


def _canonical_string(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        v.fail("invalid_input", "Eval set contains invalid Unicode.")
    parts = ['"']
    for character in value:
        code = ord(character)
        if character == '"':
            parts.append('\\"')
        elif character == "\\":
            parts.append("\\\\")
        elif character == "\b":
            parts.append("\\b")
        elif character == "\f":
            parts.append("\\f")
        elif character == "\n":
            parts.append("\\n")
        elif character == "\r":
            parts.append("\\r")
        elif character == "\t":
            parts.append("\\t")
        elif code < 0x20 or code in (0x2028, 0x2029):
            parts.append("\\u" + format(code, "04x"))
        else:
            parts.append(character)
    parts.append('"')
    return "".join(parts)
