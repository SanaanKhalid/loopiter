import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from loopiter.acceptance_gate import decide_acceptance, minimum_decisive_floor
from loopiter.decision_explain import explain_decision_text, format_explanation
from loopiter.improvement_evidence import compare


def pairs(count, incumbent, candidate):
    return [
        {"id": f"item-{index}", "incumbent": incumbent, "candidate": candidate}
        for index in range(count)
    ]


class AcceptanceGateTest(unittest.TestCase):
    def test_paired_rule_and_wilson_fallback(self):
        rule = {
            "minimum_effect": 0,
            "confidence": 0.9,
            "samples": 200,
            "seed": 17,
            "minimum_items": 0,
        }
        better = decide_acceptance(pairs(40, 0, 1), parameters=rule)
        self.assertTrue(better["accept"])
        self.assertEqual(better["method"], "paired-bootstrap")
        tied = decide_acceptance(pairs(40, 1, 1), parameters=rule)
        self.assertFalse(tied["accept"])
        worse = decide_acceptance(pairs(40, 1, 0), parameters=rule)
        self.assertFalse(worse["accept"])
        self.assertLess(worse["lower"], 0)
        clear = decide_acceptance(
            unpaired={
                "candidate_successes": 90,
                "candidate_trials": 100,
                "incumbent_successes": 40,
                "incumbent_trials": 100,
            },
            parameters=rule,
        )
        self.assertEqual(clear["method"], "newcombe-wilson")
        self.assertTrue(clear["accept"])
        noisy = decide_acceptance(
            unpaired={
                "candidate_successes": 52,
                "candidate_trials": 100,
                "incumbent_successes": 48,
                "incumbent_trials": 100,
            },
            parameters=rule,
        )
        self.assertFalse(noisy["accept"])
        guarded = decide_acceptance(pairs(4, 0, 1), parameters={**rule, "minimum_items": 10})
        self.assertEqual(guarded["reason"], "minimum_items")
        forward = decide_acceptance(
            [
                {"id": "b", "incumbent": 0, "candidate": 1},
                {"id": "a", "incumbent": 1, "candidate": 0},
            ],
            parameters=rule,
        )
        backward = decide_acceptance(
            [
                {"id": "a", "incumbent": 1, "candidate": 0},
                {"id": "b", "incumbent": 0, "candidate": 1},
            ],
            parameters=rule,
        )
        self.assertEqual(forward, backward)
        with self.assertRaises(ValueError):
            decide_acceptance(
                [
                    {"id": "a", "incumbent": 0, "candidate": 1},
                    {"id": "a", "incumbent": 1, "candidate": 0},
                ],
                parameters=rule,
            )
        fixture = json.loads(
            Path(__file__)
            .resolve()
            .parents[2]
            .joinpath("test/fixtures/acceptance-pairs.json")
            .read_text()
        )
        shared = decide_acceptance(fixture, parameters=rule)
        self.assertEqual(shared, decide_acceptance(list(reversed(fixture)), parameters=rule))
        self.assertIsInstance(shared["lower"], float)

    def test_compare_uses_the_confidence_rule_for_validation_and_audit(self):
        cases = [{"id": f"up-{i}", "baseline": 0, "candidate": 1} for i in range(8)]
        cases += [{"id": f"tie-{i}", "baseline": 0, "candidate": 0} for i in range(192)]
        rows = [{"id": case["id"]} for case in cases]
        report = {"cases": cases, "metrics": {"accuracy": 8 / 200}, "estimated_serving_cost": 0}
        fixed = self.policy()
        confidence = self.policy()
        confidence["objective"] = {
            **confidence["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "confidence": 0.9,
            "bootstrap_samples": 400,
            "bootstrap_seed": 17,
            "minimum_items": 0,
        }
        fixed_validation = compare(report, rows, fixed, False)
        confidence_validation = compare(report, rows, confidence, False)
        self.assertFalse(fixed_validation["passed"])
        self.assertEqual(fixed_validation["outcome"], "rejected")
        self.assertIsNone(fixed_validation["decisive"])
        self.assertIsNone(fixed_validation["required"])
        self.assertTrue(confidence_validation["passed"])
        self.assertEqual(confidence_validation["outcome"], "accepted")
        self.assertEqual(confidence_validation["decisive"], 8)
        self.assertEqual(confidence_validation["required"], minimum_decisive_floor(0.9))
        self.assertFalse(compare(report, rows, fixed, True)["passed"])
        self.assertTrue(compare(report, rows, confidence, True)["passed"])

    def test_decisive_floor_and_node_parity(self):
        self.assertEqual(minimum_decisive_floor(0.9), 5)
        self.assertEqual(minimum_decisive_floor(0.95), 6)
        rule = {
            "minimum_effect": 0,
            "confidence": 0.9,
            "samples": 200,
            "seed": 17,
            "minimum_items": 0,
            "minimum_decisive": 5,
        }
        short = decide_acceptance(pairs(4, 0, 1), parameters=rule)
        self.assertEqual(short["outcome"], "insufficient")
        self.assertEqual(short["decisive"], 4)
        self.assertEqual(short["required"], 5)
        self.assertIsNone(short["lower"])
        enough = decide_acceptance(pairs(5, 0, 1), parameters=rule)
        self.assertEqual(enough["outcome"], "accepted")
        self.assertGreater(enough["lower"], 0)
        ties = decide_acceptance(pairs(12, 1, 1), parameters=rule)
        self.assertEqual(ties["decisive"], 0)
        self.assertEqual(ties["outcome"], "insufficient")
        self.assertEqual(short["effect"], 1)
        self.assertEqual(enough["decisive"], 5)
        self.assertEqual(short["reason"], "insufficient_decisive")
        legacy = {
            "schemaVersion": 1,
            "kind": "acceptance-decisions",
            "seeds": [
                {
                    "seed": 4,
                    "baseline": {"id": "baseline", "promptHash": "base"},
                    "served": {"id": "baseline", "promptHash": "base"},
                    "rounds": [
                        {
                            "round": 0,
                            "candidateId": "legacy",
                            "promptHash": "old",
                            "incumbentId": "baseline",
                            "incumbentPromptHash": "base",
                            "split": "validation",
                            "rule": {
                                "minimumEffect": 0,
                                "confidence": 0.9,
                                "samples": 200,
                                "seed": 17,
                                "minimumItems": 0,
                            },
                            "decision": {
                                "accept": True,
                                "reason": "accepted",
                                "lower": 1,
                                "upper": 1,
                                "effect": 1,
                                "method": "paired-bootstrap",
                                "itemCount": 4,
                            },
                        }
                    ],
                }
            ],
        }
        text = format_explanation(explain_decision_text(json.dumps(legacy)))
        self.assertIn("decisive null required null", text)
        self.assertIn("audit null", text)
        self.assertNotIn("decisive 0", text)
        self.assertIsNone(
            explain_decision_text(json.dumps(legacy))["seeds"][0]["candidates"][0]["audit"]
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.json"
            path.write_text(json.dumps(legacy), encoding="utf-8")
            broken = Path(directory) / "broken.json"
            broken.write_text("{", encoding="utf-8")
            root = Path(__file__).resolve().parents[2]
            env = {**os.environ, "PYTHONPATH": str(root / "python" / "src")}
            bad = subprocess.run(
                [sys.executable, "-m", "loopiter", "explain", str(broken)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(bad.returncode, 1)
            usage = subprocess.run(
                [sys.executable, "-m", "loopiter", "explain"],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(usage.returncode, 2)
            explained = subprocess.run(
                [sys.executable, "-m", "loopiter", "explain", str(path), "--json"],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(explained.returncode, 0, explained.stderr)
            parsed = json.loads(explained.stdout)
            self.assertIsNone(parsed["seeds"][0]["candidates"][0]["audit"])
            self.assertIsNone(parsed["seeds"][0]["candidates"][0]["validation"]["decisive"])
            crafted = {
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
                                "candidateId": "c\u009b2J\u202e\u00e9\nseed 1 c9 audit round 9 accepted",
                                "promptHash": "p",
                                "incumbentId": "baseline",
                                "incumbentPromptHash": "base",
                                "split": "validation",
                                "rule": {
                                    "minimumEffect": 0,
                                    "confidence": 0.9,
                                    "samples": 200,
                                    "seed": 17,
                                    "minimumItems": 0,
                                },
                                "decision": {
                                    "accept": False,
                                    "outcome": "rejected",
                                    "reason": "below\u001b[2J",
                                    "lower": -1,
                                    "upper": 0,
                                    "effect": -1,
                                    "method": "paired-bootstrap",
                                    "itemCount": 5,
                                    "decisive": 5,
                                    "required": 5,
                                },
                            }
                        ],
                    }
                ],
            }
            crafted_path = Path(directory) / "crafted.json"
            crafted_path.write_text(json.dumps(crafted), encoding="utf-8")
            shown = format_explanation(explain_decision_text(json.dumps(crafted)))
            self.assertEqual(len(shown.strip().splitlines()), 2)
            self.assertNotIn("\u001b", shown)
            self.assertNotIn("\u009b", shown)
            self.assertNotIn("\u202e", shown)
            self.assertNotIn("\u00e9", shown)
            self.assertIn("\\nseed 1 c9", shown)
            self.assertIn("\\u001b", shown)
            self.assertIn("\\u009b", shown)
            self.assertIn("\\u202e", shown)
            self.assertIn("\\u00e9", shown)
            crafted_json = subprocess.run(
                [sys.executable, "-m", "loopiter", "explain", str(crafted_path), "--json"],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(crafted_json.returncode, 0, crafted_json.stderr)
            parsed_crafted = json.loads(crafted_json.stdout)
            candidate = parsed_crafted["seeds"][0]["candidates"][0]
            self.assertEqual(candidate["candidateId"], "c\u009b2J\u202e\u00e9\nseed 1 c9 audit round 9 accepted")
            self.assertEqual(candidate["validation"]["reason"], "below\u001b[2J")

    def policy(self):
        return {
            "objective": {
                "metric": "accuracy",
                "direction": "maximize",
                "minimum_improvement": 0.05,
                "range": [0, 1],
                "alpha": 0.05,
            },
            "guardrails": [{"metric": "accuracy", "comparator": "gte", "value": 0}],
            "minimum_validation_units": 1,
            "minimum_audit_units": 1,
        }


if __name__ == "__main__":
    unittest.main()
