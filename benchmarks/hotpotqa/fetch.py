#!/usr/bin/env python3
"""Download the pinned HotpotQA distractor split into benchmarks/.cache/hotpotqa.

CI must not run this. Tests use the checked-in fixtures.
Requires pyarrow: python -m pip install pyarrow

The labeled validation split is the held-out source. Train is the pool source.
Each row keeps the dataset's 10 paragraphs in order.
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
        import pyarrow.parquet as pq
    except ImportError:
        sys.exit("Install pyarrow to fetch HotpotQA parquet files.")
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, urls in FILES.items():
        rows = []
        for index, url in enumerate(urls):
            path = download(url, CACHE / f"{name}-{index}.parquet")
            rows.extend(rows_from_table(pq.read_table(path)))
        write_jsonl(CACHE / f"{name}.jsonl", rows)
    (CACHE / "manifest.json").write_text(
        json.dumps(
            {"dataset": DATASET, "config": "distractor", "revision": REVISION, "paragraphs": PARAGRAPHS},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {CACHE}")


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    request = urllib.request.Request(url, headers={"User-Agent": "loopiter-benchmark-fetch"})
    with urllib.request.urlopen(request, timeout=300) as response, dest.open("wb") as handle:
        handle.write(response.read())
    return dest


def rows_from_table(table) -> list[dict]:
    rows = []
    for record in table.to_pylist():
        context = record["context"]
        if len(context) != PARAGRAPHS:
            raise SystemExit(f"{record['id']} does not have {PARAGRAPHS} paragraphs.")
        paragraphs = []
        for paragraph in context:
            sentences = paragraph["sentences"]
            paragraphs.append(
                {"title": paragraph["title"], "text": " ".join(sentences)}
            )
        rows.append(
            {
                "id": str(record["id"]),
                "question": record["question"],
                "answer": record["answer"],
                "paragraphs": paragraphs,
            }
        )
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
