import unittest

from loopiter.acceptance_gate import decide_acceptance
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
        self.assertFalse(compare(report, rows, fixed, False)["passed"])
        self.assertTrue(compare(report, rows, confidence, False)["passed"])
        self.assertFalse(compare(report, rows, fixed, True)["passed"])
        self.assertTrue(compare(report, rows, confidence, True)["passed"])

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
