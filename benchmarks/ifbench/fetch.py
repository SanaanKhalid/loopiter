#!/usr/bin/env python3
"""Download the pinned IFBench splits into benchmarks/.cache/ifbench.

CI must not run this. Tests use the checked-in fixtures.
Requires pyarrow: python -m pip install pyarrow
"""

from __future__ import annotations

import ast
import hashlib
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
SUPPORTED_PATH = Path(__file__).with_name("supported-instructions.json")


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
    supported = load_supported_ids()
    test_rows, _test_stats = rows_from_table(pq.read_table(test_path), kind="test")
    train_built, train_stats = rows_from_table(pq.read_table(train_path), kind="train")
    test_rows, _test_support = keep_supported(test_rows, "test", supported)
    train_rows, support = keep_supported(train_built, "train", supported)
    test_ids = {row["id"] for row in test_rows}
    overlap = sorted(test_ids & {row["id"] for row in train_rows})
    if overlap:
        raise SystemExit(f"IFBench train ids overlap the test set: {overlap[:8]}")
    write_jsonl(CACHE / "test.jsonl", test_rows)
    write_jsonl(CACHE / "train.jsonl", train_rows)
    (CACHE / "manifest.json").write_text(
        json.dumps(
            {
                "testDataset": TEST_DATASET,
                "testRevision": TEST_REVISION,
                "trainDataset": TRAIN_DATASET,
                "trainRevision": TRAIN_REVISION,
                "verifierRevision": json.loads(SUPPORTED_PATH.read_text(encoding="utf-8"))["revision"],
                "testRows": len(test_rows),
                "trainRowsBefore": len(train_built),
                "trainRows": len(train_rows),
                "droppedRows": support["droppedRows"],
                "unsupportedInstructions": support["unsupported"],
                "duplicateKeys": train_stats["duplicateKeys"],
                "duplicateKeyNames": train_stats["duplicateKeyNames"],
                "rowsRewritten": train_stats["rowsRewritten"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {CACHE} test={len(test_rows)} trainBefore={len(train_built)} "
        f"train={len(train_rows)} dropped={support['droppedRows']} "
        f"unsupported={json.dumps(support['unsupported'])} "
        f"duplicateKeys={train_stats['duplicateKeys']} rowsRewritten={train_stats['rowsRewritten']} "
        f"keys={train_stats['duplicateKeyNames']}"
    )


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


def rows_from_table(table, kind: str):
    pending = []
    for record in table.to_pylist():
        if kind == "test":
            instruction_ids = list(record["instruction_id_list"])
            kwargs = [drop_nulls(item) for item in record["kwargs"]]
            prompt = record["prompt"]
            key = str(record["key"])
        else:
            prompt = record["messages"][0]["content"]
            key = str(record["key"])
            instruction_ids, kwargs = parse_ground_truth(record["ground_truth"])
        if len(instruction_ids) != len(kwargs):
            raise SystemExit(f"{key} has mismatched instructions and kwargs.")
        pending.append((key, prompt, instruction_ids, kwargs))
    if kind == "test":
        ids = [key for key, _prompt, _ids, _kwargs in pending]
        assert_unique(ids, "IFBench test")
        stats = {"duplicateKeys": 0, "rowsRewritten": 0}
    else:
        ids, stats = assign_train_ids([(key, prompt) for key, prompt, _ids, _kwargs in pending])
    rows = []
    for (key, prompt, instruction_ids, kwargs), row_id in zip(pending, ids):
        rows.append(
            {
                "id": row_id,
                "prompt": prompt,
                "instructionIdList": instruction_ids,
                "kwargs": kwargs,
            }
        )
    return rows, stats


def assign_train_ids(records: list[tuple[str, str]]) -> tuple[list[str], dict]:
    """Keep a key that appears once. Disambiguate repeats with a prompt hash."""
    counts: dict[str, int] = {}
    for key, _prompt in records:
        counts[key] = counts.get(key, 0) + 1
    ids = []
    rewritten = 0
    for key, prompt in records:
        if counts[key] == 1:
            ids.append(key)
            continue
        digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        ids.append(f"{key}-{digest}")
        rewritten += 1
    assert_unique(ids, "IFBench train")
    duplicate_key_names = sorted(key for key, count in counts.items() if count > 1)
    return ids, {
        "duplicateKeys": len(duplicate_key_names),
        "duplicateKeyNames": duplicate_key_names,
        "rowsRewritten": rewritten,
    }


def load_supported_ids() -> set[str]:
    payload = json.loads(SUPPORTED_PATH.read_text(encoding="utf-8"))
    ids = payload.get("ids")
    if not isinstance(ids, list) or not ids or any(not isinstance(item, str) for item in ids):
        raise SystemExit(f"{SUPPORTED_PATH} does not list verifier instruction ids.")
    return set(ids)


def keep_supported(rows: list[dict], kind: str, supported: set[str]):
    """Drop a train row unless every instruction id is in the pinned verifier."""
    kept = []
    dropped = 0
    counts: dict[str, int] = {}
    for row in rows:
        missing = sorted({item for item in row["instructionIdList"] if item not in supported})
        if not missing:
            kept.append(row)
            continue
        if kind == "test":
            raise SystemExit(
                f"IFBench test row {row['id']} uses unsupported instructions: {', '.join(missing)}."
            )
        dropped += 1
        for item in missing:
            counts[item] = counts.get(item, 0) + 1
    unsupported = [{"id": key, "rows": counts[key]} for key in sorted(counts)]
    return kept, {"droppedRows": dropped, "unsupported": unsupported}


def assert_unique(ids: list[str], label: str) -> None:
    seen: set[str] = set()
    for row_id in ids:
        if row_id in seen:
            raise SystemExit(f"{label} ids are not unique: {row_id}")
        seen.add(row_id)


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
