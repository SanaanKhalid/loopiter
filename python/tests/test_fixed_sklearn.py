import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
from fixed_sklearn import FixedSklearnClassifier

from loopiter import LoopiterError


@unittest.skipUnless(
    importlib.util.find_spec("sklearn"), "Optional application-side scikit-learn integration"
)
class FixedClassifierTests(unittest.IsolatedAsyncioTestCase):
    async def test_complete_threshold_cycle_preserves_real_classifier_weights(self):
        from sklearn_decision_demo import run_sklearn_demo

        for path, expected in (
            ("accepted", "completed"),
            ("rejected", "no_improvement"),
            ("insufficient", "waiting_for_evidence"),
            ("interrupted", "completed"),
            ("regression", "rolled_back"),
        ):
            with self.subTest(path=path):
                report = await run_sklearn_demo(path)
                self.assertEqual(report["result"]["state"], expected)
                self.assertEqual(
                    report["model_fingerprint_before"], report["model_fingerprint_after"]
                )
                self.assertIn("SIMULATED", report["evidence"])
                if path == "regression":
                    self.assertEqual(report["active_version"], report["baseline"])

    async def test_fixed_model_predicts_and_rejects_weight_changes(self):
        from sklearn.linear_model import LogisticRegression

        # Training happens in the test setup, never in an improvement cycle.
        model = LogisticRegression().fit([[-2], [-1], [1], [2]], ["no", "no", "yes", "yes"])
        fixed = FixedSklearnClassifier(model, feature_names=["value"], model_version="test-v1")
        self.assertEqual((await fixed.predict({"features": {"value": 2}}))["label"], "yes")
        self.assertEqual(fixed.fingerprint(), fixed.initial_fingerprint)
        model.coef_[0][0] += 0.1
        with self.assertRaises(LoopiterError) as error:
            await fixed.predict({"features": {"value": 2}})
        self.assertEqual(error.exception.code, "model_changed")
