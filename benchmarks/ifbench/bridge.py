#!/usr/bin/env python3
"""Score responses with the official IFBench verifiers.

The checker classes are imported from the installed ``ifbench`` package.
Pin that package to git commit cd189a9c2889526d8af901d2103fd3e1ffcea6df
of https://github.com/allenai/IFBench (Apache-2.0).

Strict and loose follow ``evaluation_lib.py`` at that commit. Loose also
tries the response with the first line, the last line, or both removed, and
with asterisks removed. Null kwargs are dropped before both modes, which is
what the official strict path does. The official loose path does not drop
them; cleaned JSON has no nulls, so the checks match.
"""

from __future__ import annotations

import json
import sys

from ifbench import instructions_registry


def clean_kwargs(raw):
    if not isinstance(raw, dict):
        return {}
    return {key: value for key, value in raw.items() if value is not None}


def check(instruction_id, kwargs, prompt, response):
    checker_cls = instructions_registry.INSTRUCTION_DICT[instruction_id]
    checker = checker_cls(instruction_id)
    checker.build_description(**clean_kwargs(kwargs))
    args = checker.get_instruction_args()
    if args and "prompt" in args:
        checker.build_description(prompt=prompt)
    return bool(response and str(response).strip() and checker.check_following(response))


def loose_variants(response):
    text = "" if response is None else str(response)
    lines = text.split("\n")
    without_first = "\n".join(lines[1:]).strip()
    without_last = "\n".join(lines[:-1]).strip()
    without_both = "\n".join(lines[1:-1]).strip()
    return [
        text,
        text.replace("*", ""),
        without_first,
        without_last,
        without_both,
        without_first.replace("*", ""),
        without_last.replace("*", ""),
        without_both.replace("*", ""),
    ]


def score_item(item):
    instruction_ids = list(item["instruction_id_list"])
    kwargs = list(item.get("kwargs") or [])
    prompt = item.get("prompt") or ""
    response = item.get("response") or ""
    strict = []
    loose = []
    variants = loose_variants(response)
    for index, instruction_id in enumerate(instruction_ids):
        raw = kwargs[index] if index < len(kwargs) else {}
        strict.append(check(instruction_id, raw, prompt, response))
        loose.append(
            any(check(instruction_id, raw, prompt, variant) for variant in variants)
        )
    return {
        "strictPrompt": bool(strict) and all(strict),
        "loosePrompt": bool(loose) and all(loose),
        "instructions": [
            {"id": instruction_id, "strict": strict[index], "loose": loose[index]}
            for index, instruction_id in enumerate(instruction_ids)
        ],
    }


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        items = json.loads(line)
        sys.stdout.write(json.dumps([score_item(item) for item in items]) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - the Node bridge reports the message
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        sys.exit(1)
