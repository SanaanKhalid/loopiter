#!/usr/bin/env python3
"""Download the pinned HotpotQA distractor split into benchmarks/.cache/hotpotqa.

CI must not run this. Tests use the checked-in fixtures.
Requires pyarrow: python -m pip install pyarrow

The labeled validation split is the held-out source. Train is the pool source.
Each kept row has the dataset's 10 paragraphs in order. The parquet stores
context as a struct of parallel title and sentences lists. Rows with any
other paragraph count are dropped and counted in the manifest.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

DATASET = "hotpotqa/hotpot_qa"
REVISION = "1908d6afbbead072334abe2965f91bd2709910ab"
PARAGRAPHS = 10
CACHE = Path(__file__).resolve().parents[1] / ".cache" / "hotpotqa"
FILES = {
    "train": [
        f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/distractor/train-00000-of-00002.parquet",
        f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/distractor/train-00001-of-00002.parquet",
    ],
    "validation": [
        f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/distractor/validation-00000-of-00001.parquet",
    ],
}


def main() -> None:
    if os.environ.get("CI") == "true":
        sys.exit("Refusing to download HotpotQA data when CI=true.")
    try:
        import pyarrow.parquet  # availability check; shards are read in load_parquet
    except ImportError:
        sys.exit("Install pyarrow to fetch HotpotQA parquet files.")
    CACHE.mkdir(parents=True, exist_ok=True)
    for stale in CACHE.glob("*.partial"):
        stale.unlink()
    summary = {}
    for name, urls in FILES.items():
        rows = []
        raw = 0
        dropped = 0
        for index, url in enumerate(urls):
            path = CACHE / f"{name}-{index}.parquet"
            table = load_parquet(url, path)
            shard_rows, shard_raw, shard_dropped = rows_from_table(table)
            rows.extend(shard_rows)
            raw += shard_raw
            dropped += shard_dropped
        write_jsonl(CACHE / f"{name}.jsonl", rows)
        summary[name] = {"raw": raw, "kept": len(rows), "dropped": dropped}
    (CACHE / "manifest.json").write_text(
        json.dumps(
            {
                "dataset": DATASET,
                "config": "distractor",
                "revision": REVISION,
                "paragraphs": PARAGRAPHS,
                "splits": summary,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {CACHE} {json.dumps(summary)}")


def download(url: str, dest: Path, force: bool = False) -> Path:
    return download_atomic(url, dest, timeout=300, force=force)


def load_parquet(url: str, dest: Path):
    import pyarrow.parquet as pq

    for attempt in (1, 2):
        download(url, dest, force=attempt == 2)
        try:
            return pq.read_table(dest)
        except Exception as error:
            dest.unlink(missing_ok=True)
            if attempt == 2:
                raise SystemExit(f"Could not read {dest}: {error}") from error
    raise SystemExit(f"Could not read {dest}.")


def download_atomic(url: str, dest: Path, timeout: int, force: bool = False) -> Path:
    """Write a sibling temp file, check the length, then rename over dest."""
    request = urllib.request.Request(url, headers={"User-Agent": "loopiter-benchmark-fetch"})
    temporary = dest.with_name(dest.name + ".partial")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            expected = response.headers.get("Content-Length")
            expected_n = int(expected) if expected and expected.isdigit() else None
            if (
                not force
                and dest.exists()
                and expected_n is not None
                and dest.stat().st_size == expected_n
            ):
                return dest
            # A leftover shard (for example a truncated train-0.parquet) is
            # removed before the temp file is renamed into place.
            if dest.exists():
                dest.unlink()
            total = 0
            with temporary.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    total += len(chunk)
            if expected_n is not None and total != expected_n:
                raise SystemExit(f"Download of {url} was truncated ({total} of {expected_n} bytes).")
            os.replace(temporary, dest)
    finally:
        if temporary.exists():
            temporary.unlink()
    return dest


def rows_from_table(table) -> tuple[list[dict], int, int]:
    rows = []
    raw = 0
    dropped = 0
    for record in table.to_pylist():
        raw += 1
        paragraphs = paragraphs_from_context(record["context"])
        if len(paragraphs) != PARAGRAPHS:
            dropped += 1
            continue
        rows.append(
            {
                "id": str(record["id"]),
                "question": record["question"],
                "answer": record["answer"],
                "paragraphs": paragraphs,
            }
        )
    return rows, raw, dropped


def paragraphs_from_context(context) -> list[dict]:
    """HF distractor context is {title: [...], sentences: [...]}."""
    titles, sentences = parallel_context(context)
    if len(titles) != len(sentences):
        raise SystemExit("HotpotQA context title and sentences lists differ in length.")
    paragraphs = []
    for title, sentence_list in zip(titles, sentences):
        if isinstance(sentence_list, list):
            text = " ".join(str(sentence) for sentence in sentence_list)
        else:
            text = str(sentence_list)
        paragraphs.append({"title": str(title), "text": text})
    return paragraphs


def parallel_context(context) -> tuple[list, list]:
    if isinstance(context, dict) and "title" in context and "sentences" in context:
        return list(context["title"]), list(context["sentences"])
    if isinstance(context, (list, tuple)) and len(context) == 2:
        left, right = context
        if isinstance(left, list) and isinstance(right, list):
            return list(left), list(right)
    if isinstance(context, list) and context and isinstance(context[0], dict):
        return (
            [item["title"] for item in context],
            [item["sentences"] for item in context],
        )
    raise SystemExit("HotpotQA context is not a title/sentences struct.")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
