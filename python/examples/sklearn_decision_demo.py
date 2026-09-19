"""Optional scikit-learn application; all data/outcomes are synthetic, never live evidence.

Install scikit-learn in your application environment, not in Loopiter's core.
Run: python python/examples/sklearn_decision_demo.py accepted
"""

import asyncio
import json
import sys

from autonomous_demo import run_demo
from fixed_sklearn import FixedSklearnClassifier


async def run_sklearn_demo(path="accepted"):
    from sklearn.linear_model import LogisticRegression

    # Application setup only. Loopiter never fits or modifies the classifier.
    model = LogisticRegression(random_state=0).fit(
        [[-2], [-1], [1], [2]], ["access", "access", "billing", "billing"]
    )
    fixed = FixedSklearnClassifier(
        model,
        feature_names=["value"],
        model_version="synthetic-logistic-and-index-to-feature-mapping-v1",
    )
    before = fixed.fingerprint()
    report = await run_demo("decision", path, fixed_classifier=fixed)
    report.update(
        {
            "classifier": "scikit-learn LogisticRegression; fitted before the cycle",
            "model_fingerprint_before": before,
            "model_fingerprint_after": fixed.fingerprint(),
            "data": "SYNTHETIC shifted inputs and labels; not measured customer performance",
        }
    )
    return report


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "accepted"
    if path not in ("accepted", "rejected", "insufficient", "interrupted", "regression"):
        raise SystemExit(
            "Usage: sklearn_decision_demo.py accepted|rejected|insufficient|interrupted|regression"
        )
    print(json.dumps(asyncio.run(run_sklearn_demo(path)), indent=2))
