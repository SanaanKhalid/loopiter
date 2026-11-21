import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_core import Registry

from loopiter import FeedbackLoop, ImprovementController, ImprovementWorkflow, InMemoryStore
from loopiter.eval_lock import (
    EVAL_REPORT_ID_CAP,
    check_eval_leakage,
    lock_eval_set,
    verify_eval_lock,
)
from loopiter.improvement_evidence import prepare_dataset

ROOT = Path(__file__).resolve().parents[2]
RICH = {
    "items": [
        {"id": "b", "input": {"z": 1, "a": "caf\u00e9"}, "expected": "plain"},
        {"id": "a\u0301", "input": {"text": "line\n\u007f\u202e"}, "expected": 1},
        {
            "id": "c\U0001f600",
            "input": ["  spaced \t", 0.1],
            "expected": {"n": 1.0, "ok": True, "nil": None},
        },
    ]
}


class EvalLockTests(unittest.TestCase):
    def test_checksum_is_stable_across_runs_and_key_order(self):
        first = lock_eval_set(RICH)
        second = lock_eval_set(
            {
                "items": [
                    {
                        "id": item["id"],
                        "expected": item["expected"],
                        "input": dict(reversed(list(item["input"].items())))
                        if isinstance(item["input"], dict)
                        else item["input"],
                    }
                    for item in reversed(RICH["items"])
                ]
            }
        )
        self.assertEqual(first["scheme"], 1)
        self.assertEqual(first["itemCount"], 3)
        self.assertEqual(second["sha256"], first["sha256"])
        self.assertTrue(verify_eval_lock(RICH, first)["ok"])

    def test_drift_kinds_and_relock(self):
        lock = lock_eval_set(RICH)
        added = verify_eval_lock(
            {"items": [*RICH["items"], {"id": "new", "input": "n", "expected": "n"}]},
            lock,
        )
        self.assertFalse(added["ok"])
        self.assertEqual((added["added"], added["removed"], added["changed"]), (1, 0, 0))
        self.assertEqual(added["addedIds"], ["new"])
        removed = verify_eval_lock({"items": RICH["items"][1:]}, lock)
        self.assertEqual((removed["added"], removed["removed"], removed["changed"]), (0, 1, 0))
        changed_items = [
            {**item, "expected": "edited"} if item["id"] == "b" else item for item in RICH["items"]
        ]
        changed = verify_eval_lock({"items": changed_items}, lock)
        self.assertEqual((changed["added"], changed["removed"], changed["changed"]), (0, 0, 1))
        self.assertEqual(changed["changedIds"], ["b"])
        relocked = lock_eval_set({"items": changed_items})
        self.assertNotEqual(relocked["sha256"], lock["sha256"])
        self.assertTrue(verify_eval_lock({"items": changed_items}, relocked)["ok"])

    def test_leakage_hit_miss_and_normalization(self):
        train = {
            "items": [
                {"id": "t-space", "input": "a  b", "expected": "cafe\u0301"},
                {"id": "shared", "input": "only-train", "expected": "x"},
                {"id": "t-case", "input": "Hello", "expected": "Y"},
            ]
        }
        evaluation = {
            "items": [
                {"id": "e-space", "input": "a\u00a0b", "expected": "caf\u00e9"},
                {"id": "shared", "input": "only-eval", "expected": "y"},
                {"id": "e-case", "input": "hello", "expected": "Z"},
                {"id": "clean", "input": "other", "expected": "z"},
            ]
        }
        hit = check_eval_leakage(train, evaluation)
        self.assertFalse(hit["ok"])
        self.assertEqual(hit["idOverlapCount"], 1)
        self.assertEqual(hit["contentOverlapCount"], 2)
        self.assertEqual(hit["ids"], ["e-space", "shared", "t-space"])
        expected_only = check_eval_leakage(train, evaluation, ["expected"])
        self.assertEqual(expected_only["contentOverlapCount"], 2)
        self.assertNotIn("e-case", expected_only["ids"])
        miss = check_eval_leakage(
            {"items": [{"id": "t", "input": "alpha", "expected": "one"}]},
            {"items": [{"id": "e", "input": "beta", "expected": "two"}]},
        )
        self.assertTrue(miss["ok"])
        self.assertEqual(miss["overlapCount"], 0)
        many = {
            "items": [
                {"id": f"id-{index:02d}", "input": "same", "expected": "same"}
                for index in range(EVAL_REPORT_ID_CAP + 1)
            ]
        }
        capped = check_eval_leakage(many, many)
        self.assertEqual(capped["overlapCount"], EVAL_REPORT_ID_CAP + 1)
        self.assertTrue(capped["truncated"])
        self.assertEqual(len(capped["ids"]), EVAL_REPORT_ID_CAP)

    def test_control_separators_stay_in_the_content_hash(self):
        controls = "\u001c\u001d\u001e\u001f\u0085"
        report = check_eval_leakage(
            {"items": [{"id": "k", "input": f"{controls}foo{controls}", "expected": "a"}]},
            {"items": [{"id": "s", "input": "foo", "expected": "a"}]},
            ["input"],
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["contentOverlapCount"], 0)

    def test_proto_key_is_part_of_the_hash(self):
        original = {
            "items": [
                {"id": "p", "input": {"__proto__": {"edited": False}, "keep": 1}, "expected": "ok"}
            ]
        }
        edited = {
            "items": [
                {"id": "p", "input": {"__proto__": {"edited": True}, "keep": 1}, "expected": "ok"}
            ]
        }
        drifted = verify_eval_lock(edited, lock_eval_set(original))
        self.assertFalse(drifted["ok"])
        self.assertEqual(drifted["changed"], 1)

    def test_cli_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            suite = Path(directory) / "suite.json"
            suite.write_text(json.dumps(RICH) + "\n", encoding="utf-8")
            locked = self.cli(["eval", "lock", str(suite)], directory)
            self.assertEqual(locked.returncode, 0, locked.stderr)
            verified = self.cli(["eval", "verify", str(suite)], directory)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertIn("eval lock ok", verified.stdout)
            drifted = json.loads(suite.read_text(encoding="utf-8"))
            drifted["items"].append({"id": "added", "input": "z", "expected": "z"})
            drift_path = Path(directory) / "drift.json"
            drift_path.write_text(json.dumps(drifted) + "\n", encoding="utf-8")
            lock_path = str(Path(directory) / "suite.lock.json")
            refused = self.cli(
                ["eval", "verify", str(drift_path), "--lock", lock_path, "--json"], directory
            )
            self.assertEqual(refused.returncode, 1)
            self.assertTrue(refused.stdout.isascii())
            self.assertEqual(json.loads(refused.stdout)["added"], 1)
            usage = self.cli(["eval", "leakage"], directory)
            self.assertEqual(usage.returncode, 2)
            self.assertIn("Usage: loopiter eval leakage", usage.stderr)
            train = Path(directory) / "train.json"
            evaluation = Path(directory) / "eval.json"
            train.write_text(
                json.dumps({"items": [{"id": "t", "input": "a", "expected": "b"}]}) + "\n",
                encoding="utf-8",
            )
            evaluation.write_text(
                json.dumps({"items": [{"id": "e", "input": "c", "expected": "d"}]}) + "\n",
                encoding="utf-8",
            )
            clean = self.cli(
                ["eval", "leakage", "--train", str(train), "--eval", str(evaluation)],
                directory,
            )
            self.assertEqual(clean.returncode, 0, clean.stderr)
            evaluation.write_text(train.read_text(encoding="utf-8"), encoding="utf-8")
            overlap = self.cli(
                ["eval", "leakage", "--train", str(train), "--eval", str(evaluation)],
                directory,
            )
            self.assertEqual(overlap.returncode, 1)
            self.assertIn("count 1", overlap.stdout)

    def cli(self, args, directory):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "python" / "src")}
        return subprocess.run(
            [sys.executable, "-m", "loopiter", *args],
            cwd=directory,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )


class EvalLockControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_changed_eval_rows_stop_before_a_model_or_evaluator_call(self):
        with patch("loopiter._validation.now", lambda: "2026-02-01T00:00:00Z"):
            open_run = await self.tick(None)
            self.assertGreater(open_run["dataset"], 0)
            self.assertGreater(open_run["propose"], 0)
            self.assertNotEqual(open_run["reason"], "eval_lock_drift")
            policy = snake(
                json.loads(
                    (Path(__file__).parent / "fixtures" / "autonomy.json").read_text(
                        encoding="utf-8"
                    )
                )["policy"]
            )
            lock = lock_eval_set(eval_rows(sample_dataset(), policy))
            matched = await self.tick({"lock": lock})
            self.assertGreater(matched["propose"], 0)
            changed = sample_dataset()
            changed["validation"][0]["label"] = "changed-eval-label"
            drifted = await self.tick({"lock": lock}, changed)
            self.assertEqual(drifted["dataset"], 1)
            self.assertEqual(drifted["propose"], 0)
            self.assertEqual(drifted["evaluate"], 0)
            self.assertEqual(drifted["reason"], "eval_lock_drift")

    async def tick(self, require_eval_lock, data=None):
        policy = snake(
            json.loads(
                (Path(__file__).parent / "fixtures" / "autonomy.json").read_text(encoding="utf-8")
            )["policy"]
        )
        calls = {"dataset": 0, "artifact": 0, "propose": 0, "evaluate": 0}
        rows = data if data is not None else sample_dataset()

        async def artifact(_):
            calls["artifact"] += 1
            return {"artifact_version": "v1", "configuration_hash": "model-v1"}

        async def dataset(_):
            calls["dataset"] += 1
            return rows

        async def propose(_, ctx):
            calls["propose"] += 1

            async def request():
                return {"value": [{"score": 0.9}], "tokens": 10}

            return await ctx.meter(100, request)

        async def evaluate(_input, _ctx):
            calls["evaluate"] += 1
            return {"cases": [], "metrics": {"errors": 0}, "estimated_serving_cost": 0}

        async def observe(_input, _ctx):
            raise AssertionError("observe is not part of this test")

        workflow = ImprovementWorkflow(
            id="classification",
            version="1",
            optimizer_version="1",
            evaluator_version="paired-v1",
            policy=policy,
            dataset=dataset,
            artifact=artifact,
            propose=propose,
            evaluate=evaluate,
            deployment=Registry(),
            observe=observe,
        )
        loop = FeedbackLoop(store=InMemoryStore(), namespace="eval-lock")
        kwargs = {}
        if require_eval_lock is not None:
            kwargs["require_eval_lock"] = require_eval_lock
        controller = ImprovementController(
            loop,
            workflows=[workflow],
            mode="autonomous",
            self_improving=True,
            **kwargs,
        )
        result = await controller.tick("classification")
        return {**calls, "reason": result["reason"]}


def snake(value):
    if isinstance(value, list):
        return [snake(item) for item in value]
    if isinstance(value, dict):
        return {
            re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): (
                child if key == "changeSchema" else snake(child)
            )
            for key, child in value.items()
        }
    return value


def eval_rows(data, policy):
    prepared = prepare_dataset(data, policy, "2026-02-01T00:00:00Z")
    return {
        "items": [
            {"id": row["id"], "input": row["input"], "expected": row["label"]}
            for name in ("validation", "audit")
            for row in prepared[name]
        ]
    }


def sample_dataset():
    def row(name, index, day):
        return {
            "id": f"customer-{name}-{index}",
            "episode_id": f"ticket-{name}-{index}",
            "entity_id": f"person-{name}-{index}",
            "input": {"text": "A customer correction"},
            "label": "billing",
            "source": "verified-human",
            "occurred_at": f"2026-01-0{day}T00:00:00Z",
            "observed_at": f"2026-01-0{day}T01:00:00Z",
        }

    return {
        "version": "customer-export-1",
        "optimization": [row("train", index, 1) for index in range(3)],
        "validation": [row("validation", index, 2) for index in range(20)],
        "audit": [row("audit", index, 3) for index in range(50)],
    }


if __name__ == "__main__":
    unittest.main()
