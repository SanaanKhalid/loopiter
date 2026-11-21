import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from loopiter.acceptance_gate import (
    decide_retention,
    next_best_ever,
    not_measured_retention,
    remember_retention_decision,
)
from loopiter.decision_explain import (
    explain_decision_text,
    format_explanation,
    format_retention_status,
    parse_retention_ledger,
)

RULE = {
    "minimum_effect": 0,
    "confidence": 0.9,
    "samples": 200,
    "seed": 17,
    "minimum_items": 0,
    "minimum_decisive": 5,
}


def scores(score, count=8, prefix="item"):
    return [{"id": f"{prefix}-{index}", "score": score} for index in range(count)]


def best(score, count=8):
    return {"id": "best", "score": score, "items": scores(score, count)}


class RetentionTests(unittest.TestCase):
    def test_pass_fail_and_not_measured(self):
        regressed = decide_retention(
            enabled=True,
            candidate_items=scores(0.2),
            best_ever=best(1),
            margin=0.05,
            parameters=RULE,
        )
        self.assertEqual(regressed["outcome"], "retention_regression")
        self.assertEqual(regressed["reason"], "retention_regression")
        self.assertEqual(regressed["best_ever_id"], "best")
        self.assertEqual(regressed["items"], 8)
        self.assertLess(regressed["lower"], -0.05)

        within = decide_retention(
            enabled=True,
            candidate_items=scores(0.9),
            best_ever=best(1),
            margin=0.2,
            parameters=RULE,
        )
        self.assertEqual(within["outcome"], "pass")
        self.assertGreaterEqual(within["lower"], -0.2)

        off = decide_retention(
            enabled=False,
            candidate_items=scores(0),
            best_ever=best(1),
            margin=0,
            parameters=RULE,
        )
        self.assertEqual(off, not_measured_retention())
        self.assertIsNone(off["items"])

        fresh = decide_retention(
            enabled=True,
            candidate_items=scores(1),
            best_ever=None,
            margin=0.05,
            parameters=RULE,
        )
        self.assertEqual(fresh, not_measured_retention())

        disjoint = decide_retention(
            enabled=True,
            candidate_items=scores(0, prefix="other"),
            best_ever=best(1),
            margin=0.05,
            parameters=RULE,
        )
        self.assertEqual(disjoint["outcome"], "not_measured")
        self.assertIsNone(disjoint["items"])
        self.assertNotIn(": 0", json.dumps(disjoint))

        short = decide_retention(
            enabled=True,
            candidate_items=scores(0.2, 2),
            best_ever=best(1, 2),
            margin=0.05,
            parameters=RULE,
        )
        self.assertEqual(short["outcome"], "insufficient")
        self.assertEqual(short["reason"], "insufficient_decisive")
        self.assertIsNone(short["lower"])
        self.assertEqual(short["items"], 2)

        shuffled = decide_retention(
            enabled=True,
            candidate_items=list(reversed(scores(0.2))),
            best_ever={**best(1), "items": list(reversed(scores(1)))},
            margin=0.05,
            parameters=RULE,
        )
        self.assertEqual(shuffled["lower"], regressed["lower"])
        self.assertEqual(shuffled["outcome"], regressed["outcome"])

    def test_best_ever_updates_only_when_higher(self):
        current = next_best_ever(current=None, candidate_id="first", items=scores(0.8))
        self.assertEqual(current["id"], "first")
        self.assertEqual(current["score"], 0.8)
        kept = next_best_ever(current=current, candidate_id="lower", items=scores(0.7))
        self.assertEqual(kept["id"], "first")
        tied = next_best_ever(current=current, candidate_id="tied", items=scores(0.8))
        self.assertEqual(tied["id"], "first")
        raised = next_best_ever(current=current, candidate_id="higher", items=scores(0.95))
        self.assertEqual(raised["id"], "higher")
        minimized = next_best_ever(
            current={"id": "high", "score": 0.4, "items": scores(0.4)},
            candidate_id="low",
            items=scores(0.1),
            direction="minimize",
        )
        self.assertEqual(minimized["id"], "low")
        rolled = remember_retention_decision(
            {"best_ever": raised, "decisions": []},
            {**not_measured_retention(), "candidate_id": "rolled"},
        )
        self.assertEqual(rolled["best_ever"]["id"], "higher")

    def test_status_is_read_only_and_explain_shows_retention(self):
        crafted = "c\u007f\u009b2J\u202e\u00e9\U0001f600\nbest"
        ledger = {
            "schemaVersion": 1,
            "kind": "retention-ledger",
            "bestEver": {"id": crafted, "score": 0.8, "items": [{"id": crafted, "score": 0.8}]},
            "decisions": [
                {
                    "candidateId": "next",
                    "outcome": "retention_regression",
                    "reason": "retention_regression",
                    "bestEverId": crafted,
                    "lower": -0.25,
                    "margin": 0.05,
                    "items": 8,
                }
            ],
        }
        text = format_retention_status(parse_retention_ledger(json.dumps(ledger)))
        self.assertTrue(all(char == "\n" or 0x20 <= ord(char) <= 0x7E for char in text))
        self.assertNotIn("\u007f", text)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.json"
            path.write_text(json.dumps(ledger) + "\n", encoding="utf-8")
            env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
            shown = subprocess.run(
                [sys.executable, "-m", "loopiter", "retention", "status", str(path)],
                cwd=directory,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(shown.returncode, 0, shown.stderr)
            self.assertEqual(shown.stdout, text)
            empty = subprocess.run(
                [sys.executable, "-m", "loopiter", "retention", "status"],
                cwd=directory,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(empty.returncode, 0, empty.stderr)
            self.assertEqual(empty.stdout, "bestEver null score null items null\n")
            before = path.read_bytes()
            self.assertEqual(path.read_bytes(), before)
        log = {
            "schemaVersion": 1,
            "kind": "acceptance-decisions",
            "seeds": [
                {
                    "seed": 1,
                    "baseline": {"id": "baseline", "promptHash": "base"},
                    "served": {"id": "baseline", "promptHash": "base"},
                    "rounds": [
                        {
                            "round": 0,
                            "candidateId": "kept",
                            "promptHash": "p",
                            "split": "audit",
                            "rule": {
                                "minimumEffect": 0,
                                "confidence": 0.9,
                                "samples": 200,
                                "seed": 17,
                                "minimumItems": 0,
                            },
                            "decision": {
                                "accept": True,
                                "outcome": "accepted",
                                "reason": "accepted",
                                "lower": 0.2,
                                "upper": 0.4,
                                "effect": 0.3,
                                "method": "paired-bootstrap",
                                "itemCount": 8,
                                "retention": ledger["decisions"][0],
                            },
                        }
                    ],
                }
            ],
        }
        explained = format_explanation(explain_decision_text(json.dumps(log)))
        self.assertIn("retention retention_regression", explained)
        self.assertIn("retentionItems 8", explained)
        bare_decision = dict(log["seeds"][0]["rounds"][0]["decision"])
        bare_decision.pop("retention")
        bare = format_explanation(
            explain_decision_text(
                json.dumps(
                    {
                        **log,
                        "seeds": [
                            {
                                **log["seeds"][0],
                                "rounds": [
                                    {**log["seeds"][0]["rounds"][0], "decision": bare_decision}
                                ],
                            }
                        ],
                    }
                )
            )
        )
        self.assertIn("retention not_measured", bare)
        self.assertIn("retentionItems null", bare)
        self.assertNotIn("retentionItems 0", bare)


if __name__ == "__main__":
    unittest.main()
