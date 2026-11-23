"""Candidate rows on an acceptance decision log.

Prompt text can contain user data, so `record_prompt_text` defaults to false
and the stored row keeps the hash only. The Node option is `recordPromptText`.
The JSON field names stay camelCase, matching the log written by the benchmark.
"""

from __future__ import annotations

import hashlib
from typing import Any


def prompt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def note_candidate(
    log: dict[str, Any],
    candidate: dict[str, str],
    *,
    record_prompt_text: bool = False,
) -> None:
    """Record one proposed candidate. Text is stored only when `record_prompt_text` is true."""
    prompt = candidate["prompt"]
    hashed = prompt_hash(prompt)
    if hashed != candidate["promptHash"]:
        raise ValueError(f"Candidate {candidate['id']} prompt does not match its hash.")
    stored: dict[str, str] = {"id": candidate["id"], "promptHash": candidate["promptHash"]}
    if record_prompt_text:
        stored["prompt"] = prompt
    rows: list[dict[str, str]] = log.setdefault("candidates", [])
    same = next((row for row in rows if row["id"] == candidate["id"]), None)
    if same is not None:
        if same["promptHash"] != candidate["promptHash"]:
            raise ValueError(
                f"Candidate {candidate['id']} prompt does not match the recorded text."
            )
        if record_prompt_text:
            same["prompt"] = prompt
        else:
            same.pop("prompt", None)
        return
    placeholder = f"prompt:{hashed[:12]}"
    pending = next((row for row in rows if row["id"] == placeholder), None)
    if pending is not None and candidate["id"] != placeholder:
        pending["id"] = candidate["id"]
        pending["promptHash"] = candidate["promptHash"]
        if record_prompt_text:
            pending["prompt"] = prompt
        else:
            pending.pop("prompt", None)
        return
    rows.append(stored)


def validate_recorded_candidates(candidates: Any, seed: int) -> None:
    """Accept a hash-only row or a row whose prompt text matches its hash."""
    if candidates is None:
        return
    if not isinstance(candidates, list):
        raise ValueError(f"Seed {seed} has a malformed candidate list.")
    seen: set[str] = set()
    for candidate in candidates:
        if (
            not isinstance(candidate, dict)
            or not isinstance(candidate.get("id"), str)
            or not candidate["id"]
        ):
            raise ValueError(f"Seed {seed} has a candidate without an id.")
        if not isinstance(candidate.get("promptHash"), str) or not candidate["promptHash"]:
            raise ValueError(f"Seed {seed} candidate {candidate.get('id')} is missing its hash.")
        prompt = candidate.get("prompt")
        if prompt is not None:
            if not isinstance(prompt, str) or not prompt:
                raise ValueError(f"Seed {seed} candidate {candidate['id']} is missing its prompt.")
            if candidate["promptHash"] != prompt_hash(prompt):
                raise ValueError(
                    f"Seed {seed} candidate {candidate['id']} prompt does not match its hash."
                )
        if candidate["id"] in seen:
            raise ValueError(f"Seed {seed} repeats candidate {candidate['id']}.")
        seen.add(candidate["id"])
