#!/usr/bin/env python3
"""Download the pinned IFBench splits into benchmarks/.cache/ifbench.

CI must not run this. Tests use the checked-in fixtures.
Requires pyarrow: python -m pip install pyarrow
"""

from __future__ import annotations

import ast
import json
import os
import sys
import urllib.request
from pathlib import Path

TEST_DATASET = "allenai/IFBench_test"
TEST_REVISION = "ed7c12452594b7028b15807b86d3938150b663ae"
TRAIN_DATASET = "allenai/IF_multi_constraints_upto5"
TRAIN_REVISION = "2e3a77407b7fce69f95b248d64a884e3ae1c2423"
CACHE = Path(__file__).resolve().parents[1] / ".cache" / "ifbench"


def main() -> None:
    if os.environ.get("CI") == "true":
        sys.exit("Refusing to download IFBench data when CI=true.")
    try:
        import pyarrow.parquet as pq
    except ImportError:
        sys.exit("Install pyarrow to fetch IFBench parquet files.")
    CACHE.mkdir(parents=True, exist_ok=True)
    test_path = download(
        f"https://huggingface.co/datasets/{TEST_DATASET}/resolve/{TEST_REVISION}/data/train-00000-of-00001.parquet",
        CACHE / "test.parquet",
    )
    train_path = download(
        f"https://huggingface.co/datasets/{TRAIN_DATASET}/resolve/{TRAIN_REVISION}/data/train-00000-of-00001.parquet",
        CACHE / "train.parquet",
    )
    write_jsonl(CACHE / "test.jsonl", rows_from_table(pq.read_table(test_path), kind="test"))
    write_jsonl(CACHE / "train.jsonl", rows_from_table(pq.read_table(train_path), kind="train"))
    (CACHE / "manifest.json").write_text(
        json.dumps(
            {
                "testDataset": TEST_DATASET,
                "testRevision": TEST_REVISION,
                "trainDataset": TRAIN_DATASET,
                "trainRevision": TRAIN_REVISION,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {CACHE}")


def download(url: str, dest: Path) -> Path:
    return download_atomic(url, dest, timeout=120)


def download_atomic(url: str, dest: Path, timeout: int) -> Path:
    """Write a sibling temp file, check the length, then rename over dest."""
    request = urllib.request.Request(url, headers={"User-Agent": "loopiter-benchmark-fetch"})
    temporary = dest.with_name(dest.name + ".partial")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            expected = response.headers.get("Content-Length")
            expected_n = int(expected) if expected and expected.isdigit() else None
            if dest.exists() and expected_n is not None and dest.stat().st_size == expected_n:
                return dest
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


def rows_from_table(table, kind: str) -> list[dict]:
    rows = []
    for record in table.to_pylist():
        if kind == "test":
            instruction_ids = list(record["instruction_id_list"])
            kwargs = [drop_nulls(item) for item in record["kwargs"]]
            prompt = record["prompt"]
            row_id = str(record["key"])
        else:
            prompt = record["messages"][0]["content"]
            row_id = str(record["key"])
            instruction_ids, kwargs = parse_ground_truth(record["ground_truth"])
        if len(instruction_ids) != len(kwargs):
            raise SystemExit(f"{row_id} has mismatched instructions and kwargs.")
        rows.append(
            {
                "id": row_id,
                "prompt": prompt,
                "instructionIdList": instruction_ids,
                "kwargs": kwargs,
            }
        )
    return rows


def parse_ground_truth(value):
    parsed = ast.literal_eval(value) if isinstance(value, str) else value
    item = parsed[0] if isinstance(parsed, list) else parsed
    instruction_ids = list(item["instruction_id"])
    kwargs = []
    for raw in item["kwargs"]:
        kwargs.append({} if raw is None else drop_nulls(raw))
    return instruction_ids, kwargs


def drop_nulls(value) -> dict:
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if item is not None}


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
