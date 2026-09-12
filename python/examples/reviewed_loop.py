"""Offline, simulated fixture demo. No model calls, credentials, telemetry or live metrics."""

import argparse
import asyncio
import difflib
import json
from collections import Counter
from copy import deepcopy

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError, fingerprint

# Label schema, dates, evaluator, guardrails and thresholds are application-owned.
LABELS = ("billing", "technical", "other")
BASELINE = {"billing_keywords": ["charge"], "technical_keywords": ["error"]}
CORRECTIONS = [
    {
        "episode": "correction-1",
        "entity": "customer-1",
        "time": "2026-01-01T00:00:00Z",
        "text": "invoice missing",
        "label": "billing",
    },
    {
        "episode": "correction-2",
        "entity": "customer-2",
        "time": "2026-01-02T00:00:00Z",
        "text": "invoice incorrect",
        "label": "billing",
    },
]
HOLDOUT = [
    {
        "episode": "holdout-1",
        "entity": "customer-3",
        "time": "2026-02-01T00:00:00Z",
        "text": "resend invoice receipt",
        "label": "billing",
    },
    {
        "episode": "holdout-2",
        "entity": "customer-4",
        "time": "2026-02-02T00:00:00Z",
        "text": "invoice total please",
        "label": "billing",
    },
    {
        "episode": "holdout-3",
        "entity": "customer-5",
        "time": "2026-02-03T00:00:00Z",
        "text": "charge explanation",
        "label": "billing",
    },
    {
        "episode": "holdout-4",
        "entity": "customer-6",
        "time": "2026-02-04T00:00:00Z",
        "text": "error loading app",
        "label": "technical",
    },
]
GUARDRAILS = [{"text": "hello", "label": "other"}, {"text": "error code", "label": "technical"}]


def classify(text, rules):
    tokens = set(text.lower().split())
    for label in ("billing", "technical"):
        if tokens.intersection(rules[f"{label}_keywords"]):
            return label
    return "other"


def accuracy(dataset, rules):
    return sum(classify(row["text"], rules) == row["label"] for row in dataset) / len(dataset)


class FixtureRegistry:
    """In-memory EXAMPLE ONLY. Production needs durable receipts and atomic fencing."""

    def __init__(self, interrupt=False):
        self.version = "baseline-v1"
        self.versions = {self.version: deepcopy(BASELINE)}
        self.receipts = {}
        self.interrupt = interrupt

    def predict(self, text):
        return classify(text, self.versions[self.version])

    async def apply(self, request):
        candidate = request["candidate"]
        self.versions[candidate["id"]] = deepcopy(candidate["proposed_change"])
        result = self._change(request, candidate["id"])
        if self.interrupt:
            self.interrupt = False
            raise RuntimeError("Simulated lost response after registry changed")
        return result

    async def rollback(self, request):
        return self._change(request, request["attempt"]["restore_artifact_version"])

    def _change(self, request, version):
        key = request["idempotency_key"]
        if key in self.receipts:
            return self.receipts[key]
        if request["attempt"]["expected_artifact_version"] != self.version:
            raise RuntimeError("External version conflict")
        result = {
            "attempt_id": key,
            "artifact_version": version,
            "previous_artifact_version": self.version,
        }
        self.receipts[key] = result
        self.version = version
        return result

    async def inspect(self, request):
        receipt = self.receipts.get(request["idempotency_key"])
        return {"status": "applied", "receipt": receipt} if receipt else {"status": "unknown"}


async def demo(*, reject=False, interrupt=False):
    for key in ("episode", "entity"):
        assert not {r[key] for r in CORRECTIONS}.intersection(r[key] for r in HOLDOUT)
    assert max(r["time"] for r in CORRECTIONS) < min(r["time"] for r in HOLDOUT)
    assert all(r["label"] in LABELS for r in CORRECTIONS + HOLDOUT + GUARDRAILS)
    loop = FeedbackLoop(store=InMemoryStore(), namespace="python/offline-fixture")
    registry = FixtureRegistry(interrupt)
    for row in CORRECTIONS:
        execution = await loop.record_execution(
            id=row["episode"],
            kind="prediction",
            episode_id=row["episode"],
            entity_id=row["entity"],
            started_at=row["time"],
            input={"text": row["text"]},
            output={"label": registry.predict(row["text"])},
            metadata={"segment": "billing"},
            artifacts={"model": "simulated-keyword-v1", "rules": registry.version},
        )
        await loop.record_signal(
            id="review-" + row["episode"],
            execution_id=execution["id"],
            kind="correction",
            name="verified_correct",
            source="fixture-reviewer",
            value=False,
            correction={"label": row["label"]},
            observed_at=row["time"],
        )
    findings = await loop.analyze(
        dimensions=["metadata.segment"], minimum_support=2, time_bucket="day"
    )
    assert findings
    # Only correction texts reach the deterministic proposer; holdout is never proposal input.
    common = Counter(token for row in CORRECTIONS for token in set(row["text"].split()))
    proposal = deepcopy(BASELINE)
    if not reject:
        proposal["billing_keywords"] += sorted(
            token for token, count in common.items() if count >= 2
        )
    dataset_hash = fingerprint({"holdout": HOLDOUT, "guardrails": GUARDRAILS, "labels": LABELS})
    evidence = {
        "manifest": findings[0]["evidence"],
        "correction_hash": fingerprint(CORRECTIONS),
        "evaluator_version": "exact-match-v1",
        "dataset_hash": dataset_hash,
    }
    candidate_id = fingerprint(
        {"target": "support-routing", "proposal": proposal, "evidence": evidence}
    )
    candidate = await loop.create_candidate(
        id=candidate_id,
        target={"kind": "routing", "key": "support"},
        proposed_change=proposal,
        evidence=evidence,
        risk="low",
    )
    diff = "\n".join(
        difflib.unified_diff(
            json.dumps(BASELINE, indent=2).splitlines(),
            json.dumps(proposal, indent=2).splitlines(),
            fromfile="baseline",
            tofile="candidate",
            lineterm="",
        )
    )
    print("SIMULATED OFFLINE FIXTURE — not live model performance\n" + diff)

    async def evaluator(c, cancellation):
        baseline = accuracy(HOLDOUT, BASELINE)
        candidate_score = accuracy(HOLDOUT, c["proposed_change"])
        guardrail_score = accuracy(GUARDRAILS, c["proposed_change"])
        return {
            "passed": candidate_score - baseline >= 0.25 and guardrail_score == 1,
            "metrics": {
                "baseline_accuracy": baseline,
                "candidate_accuracy": candidate_score,
                "improvement": candidate_score - baseline,
                "guardrail_accuracy": guardrail_score,
            },
        }

    candidate = await loop.evaluate_candidate(
        candidate["id"],
        evaluator,
        evaluator_name="exact-match",
        version="exact-match-v1",
        dataset_hash=dataset_hash,
    )
    evaluation = candidate["evaluations"][-1]
    report = {
        "mode": "simulated",
        "evidence": evidence,
        "metrics": evaluation["metrics"],
        "gates_passed": evaluation["passed"],
        "deployed": False,
        "reconciled": False,
        "rolled_back": False,
    }
    if not evaluation["passed"]:
        await loop.reject_candidate(candidate["id"], reason="Independent fixture gates failed")
        report["result"] = "No candidate passed."
    else:
        # Explicit approval for this fixture demonstration, NOT an unattended default.
        await loop.approve_candidate(
            candidate["id"], actor="explicit-offline-demo-reviewer", evaluation_id=evaluation["id"]
        )
        probe = "invoice total please"
        report["prediction_before"] = registry.predict(probe)
        try:
            await loop.deploy_candidate(
                candidate["id"], registry, expected_artifact_version="baseline-v1"
            )
        except LoopiterError as error:
            if error.code != "deployment_pending":
                raise
            attempt = await loop.reconcile_deployment(error.attempt_id, registry)
            assert attempt["status"] == "succeeded"
            report["reconciled"] = True
        report["deployed"] = True
        report["prediction_after"] = registry.predict(probe)
        await loop.rollback_candidate(candidate["id"], registry)
        report["prediction_after_rollback"] = registry.predict(probe)
        report["rolled_back"] = True
    await loop.close()
    print(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reject", action="store_true", help="Generate a candidate that fails measured gates"
    )
    parser.add_argument(
        "--interrupt",
        action="store_true",
        help="Lose an apply response, then inspect and reconcile",
    )
    args = parser.parse_args()
    asyncio.run(demo(reject=args.reject, interrupt=args.interrupt))
