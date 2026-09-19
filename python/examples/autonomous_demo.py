"""SIMULATED only. Run: python python/examples/autonomous_demo.py prompt accepted"""

import asyncio
import json
import sys
from copy import deepcopy
from datetime import UTC, datetime, timedelta

from autonomous_workflows import (
    SAFETY,
    decision_routing_workflow,
    model_routing_workflow,
    prompt_workflow,
)

from loopiter import FeedbackLoop, ImprovementController, InMemoryStore, fingerprint


class Registry:
    def __init__(self, artifact, configuration, interrupted=False):
        self.version = fingerprint(artifact)
        self.artifacts = {self.version: artifact}
        self.receipts = {}
        self.configuration, self.interrupted = configuration, interrupted

    async def current(self):
        return {"version": self.version, "artifact": await self.get(self.version)}

    async def get(self, version):
        return deepcopy(self.artifacts[version])

    async def apply(self, request):
        result = self.change(
            request, request["candidate"]["content_hash"], request["candidate"]["proposed_change"]
        )
        if self.interrupted:
            raise RuntimeError("INJECTED lost receipt")
        return result

    async def rollback(self, request):
        version = request["attempt"]["restore_artifact_version"]
        return self.change(request, version, await self.get(version))

    def change(self, request, version, artifact):
        key = request["attempt"]["id"]
        if key in self.receipts:
            if self.receipts[key] is None:
                raise RuntimeError("Fenced")
            return self.receipts[key]
        if self.version != request["attempt"]["expected_artifact_version"]:
            raise RuntimeError("Version conflict")
        current_hash = fingerprint(self.configuration)
        if (
            request["attempt"]["operation"] == "apply"
            and request["candidate"]["baseline"]["configuration_hash"] != current_hash
        ):
            raise RuntimeError("Configuration conflict")
        receipt = {
            "attempt_id": key,
            "artifact_version": version,
            "previous_artifact_version": self.version,
        }
        self.artifacts[version] = deepcopy(artifact)
        self.version = version
        self.receipts[key] = receipt
        return receipt

    async def inspect(self, request):
        key = request["attempt"]["id"]
        if self.receipts.get(key):
            return {"status": "applied", "receipt": self.receipts[key]}
        self.receipts[key] = None
        return {"status": "not_applied"}


async def run_demo(kind, path="accepted", *, fixed_classifier=None):
    if fixed_classifier is not None and kind != "decision":
        raise ValueError("A fixed classifier is supported only by the decision-routing demo.")
    now = datetime(2026, 5, 1, tzinfo=UTC)

    def clock():
        return now.isoformat().replace("+00:00", "Z")

    loop = FeedbackLoop(
        store=InMemoryStore(),
        namespace=f"simulated/{kind}/{path}",
        clock=clock,
        maximum_payload_bytes=1048576,
    )
    labels = ["billing", "access", "other"] if kind == "prompt" else ["billing", "access"]
    configuration = (
        {"model": "simulated-keyword-classifier", "labels": labels, "safety": SAFETY}
        if kind == "prompt"
        else {"models": ["premium", "economy"], "segments": ["simple", "complex"]}
        if kind == "models"
        else {
            "model_fingerprint": fixed_classifier.fingerprint()
            if fixed_classifier is not None
            else "fixed-weights-and-preprocessing-v1",
            "abstention_cost": 0.3,
            "labels": labels,
        }
    )
    initial = (
        {"fragment": "Default to other."}
        if kind == "prompt"
        else {"simple": "premium", "complex": "premium"}
        if kind == "models"
        else {"threshold": 0}
    )
    registry = Registry(initial, configuration, path == "interrupted")
    baseline = registry.version

    def rows(partition, count, day):
        return [
            {
                "id": f"export-{partition}-{i}",
                "episode_id": f"ticket-{partition}-{i}",
                "entity_id": f"customer-{partition}-{i}",
                "occurred_at": f"2026-04-0{day}T00:00:00Z",
                "observed_at": f"2026-04-0{day}T01:00:00Z",
                "source": "verified-export",
                "input": {
                    "text": "refund for a charge" if i % 2 else "password reset",
                    "segment": "simple" if i % 2 else "complex",
                    "index": i,
                },
                "label": "billing" if i % 2 else "access",
            }
            for i in range(count)
        ]

    snapshot = {
        "version": "simulated-customer-export-v1",
        "optimization": rows("optimization", 10, 1),
        "validation": rows("validation", 100, 2),
        "audit": [] if path == "insufficient" else rows("audit", 200, 3),
    }
    schema = (
        {
            "type": "object",
            "properties": {"fragment": {"type": "string", "maxLength": 1000}},
            "required": ["fragment"],
            "additionalProperties": False,
        }
        if kind == "prompt"
        else {
            "type": "object",
            "properties": {
                s: {"type": "string", "enum": ["premium", "economy"]} for s in ["simple", "complex"]
            },
            "required": ["simple", "complex"],
            "additionalProperties": False,
        }
        if kind == "models"
        else {
            "type": "object",
            "properties": {"threshold": {"type": "number", "enum": [0, 0.8, 0.95]}},
            "required": ["threshold"],
            "additionalProperties": False,
        }
    )
    # Example values for this simulation, not universal safe thresholds.
    policy = {
        "version": "simulation-only-v1",
        "target": {"kind": "prompt" if kind == "prompt" else "routing", "key": "isolated-" + kind},
        "change_schema": schema,
        "objective": {
            "metric": "cost"
            if kind == "models"
            else "utility"
            if kind == "decision"
            else "accuracy",
            "direction": "minimize" if kind == "models" else "maximize",
            "minimum_improvement": 0.05,
            "range": [0, 1],
            "alpha": 0.05,
        },
        "guardrails": [
            {"metric": "coverage", "comparator": "gte", "value": 0.3},
            {"metric": "errors", "comparator": "lte", "value": 0.05},
        ]
        if kind == "decision"
        else [
            {"metric": "accuracy", "comparator": "gte", "value": 0.95},
            {"metric": "latency_ms", "comparator": "lte", "value": 100},
        ],
        "trusted_sources": ["verified-export"],
        "minimum_new_units": 10,
        "minimum_validation_units": 100,
        "minimum_audit_units": 200,
        "outcome_maturity_ms": 3600000,
        "maximum_rows": 1000,
        "daily": {"model_requests": 10, "tokens": 10000, "deployments": 1},
        "callback_reservation": {"model_requests": 3, "tokens": 3000},
        "cooldown_ms": 3600000,
        "rollout": {"mode": "immediate"},
        "observation": {
            "minimum_duration_ms": 3600000,
            "timeout_ms": 86400000,
            "minimum_units": 20,
            "guardrails": [{"metric": "errors", "comparator": "lte", "value": 0.05}],
            "on_timeout": "rollback",
            "on_failure": "rollback",
        },
        "on_insufficient_evidence": "wait",
        "on_uncertain_deployment": "reconcile",
    }

    async def dataset(_):
        return snapshot

    async def fixed_predict(input_):
        i = input_["index"]
        truth = "billing" if i % 2 else "access"
        if fixed_classifier is not None:
            # Synthetic distribution shift: uncertain inputs have misleading features.
            # This mapping is fixed throughout the cycle and versioned by the caller.
            sign = 1 if truth == "billing" else -1
            value = -sign * 0.1 if i % 5 < 3 else sign * 2
            return await fixed_classifier.predict({"features": {"value": value}})
        return {
            "label": ("access" if truth == "billing" else "billing") if i % 5 < 3 else truth,
            "confidence": 0.55 if i % 5 < 3 else 0.9,
        }

    async def prompt_predict(input_, _):
        label = (
            ("billing" if "refund" in input_["text"] else "access")
            if "Billing" in input_["fragment"]
            else "other"
        )
        return {"label": label, "cost": 0, "latency_ms": 0}

    async def model_predict(model, input_, _):
        return {
            "label": "billing" if "refund" in input_["text"] else "access",
            "cost": 0.1 if model == "economy" else 1,
            "latency_ms": 10 if model == "economy" else 20,
        }

    async def observe(input_, _):
        artifact = (await registry.current())["artifact"]
        unit_ids, errors = [], 0
        for row in rows("production", 20, 4):
            if kind == "prompt":
                predicted = (
                    await prompt_predict(
                        {"fragment": artifact["fragment"], "text": row["input"]["text"]}, None
                    )
                )["label"]
            elif kind == "models":
                predicted = (
                    await model_predict(artifact[row["input"]["segment"]], row["input"], None)
                )["label"]
            else:
                pred = await fixed_predict(row["input"])
                predicted = (
                    "escalated" if pred["confidence"] < artifact["threshold"] else pred["label"]
                )
            if path == "regression":
                predicted = "wrong"
            correct = predicted == "escalated" or predicted == row["label"]
            errors += not correct
            unit_ids.append(row["entity_id"])
            execution = await loop.record_execution(
                id=row["id"],
                episode_id=row["episode_id"],
                entity_id=row["entity_id"],
                kind="prediction",
                input=row["input"],
                output=predicted,
                artifacts={"version": registry.version},
                started_at=input_["deployed_at"],
            )
            await loop.record_signal(
                id="outcome-" + row["id"],
                execution_id=execution["id"],
                kind="outcome",
                name="correct",
                source="verified-export",
                value=correct,
                observed_at=clock(),
            )
        return {
            "artifact_version": registry.version,
            "configuration_hash": fingerprint(configuration),
            "started_at": input_["deployed_at"],
            "ended_at": clock(),
            "complete": True,
            "unit_ids": unit_ids,
            "metrics": {"errors": errors / 20},
        }

    common = {
        "id": "simulated-" + kind,
        "version": "1",
        "policy": policy,
        "registry": registry,
        "dataset": dataset,
        "observe": observe,
    }
    if kind == "prompt":

        async def propose_fragment(examples, _):
            if not examples:
                return []
            return [
                "Default to other."
                if path == "rejected"
                else "Billing: refund/charge. Access: password."
            ]

        workflow = prompt_workflow(
            common,
            model_id="simulated-keyword-classifier",
            labels=labels,
            propose_fragment=propose_fragment,
            predict=prompt_predict,
        )
    elif kind == "models":
        proposals = [
            {"simple": "premium", "complex": "premium"}
            if path == "rejected"
            else {"simple": "economy", "complex": "economy"}
        ]
        workflow = model_routing_workflow(
            common,
            models=["premium", "economy"],
            segments=["simple", "complex"],
            proposals=proposals,
            predict=model_predict,
        )
    else:
        workflow = decision_routing_workflow(
            common,
            model_fingerprint=fixed_classifier.fingerprint
            if fixed_classifier is not None
            else "fixed-weights-and-preprocessing-v1",
            thresholds=[0] if path == "rejected" else [0, 0.8, 0.95],
            abstention_cost=0.3,
            labels=labels,
            predict=fixed_predict,
        )
    controller = ImprovementController(
        loop, workflows=[workflow], mode="autonomous", self_improving=True
    )
    transitions = []
    for _ in range(10):
        result = await controller.tick(workflow.id)
        transitions.append({"state": result["state"], "reason": result["reason"]})
        if result["state"] in (
            "completed",
            "no_improvement",
            "rolled_back",
            "waiting_for_evidence",
            "failed",
        ):
            break
        if result["state"] == "observing":
            now += timedelta(hours=2)
    run = await controller.get_run(result["run_id"]) if result["run_id"] else None
    return {
        "evidence": "SIMULATED / isolated in-memory application",
        "kind": kind,
        "path": path,
        "transitions": transitions,
        "result": result,
        "baseline": baseline,
        "active_version": registry.version,
        "validation": run["data"]["comparisons"] if run else None,
        "audit": run["data"].get("audit") if run else None,
        "observations": [r["data"] for r in (await loop.list("observations"))["items"]],
    }


if __name__ == "__main__":
    kind, path = (
        (sys.argv[1:] + ["prompt", "accepted"])[:2]
        if len(sys.argv) == 1
        else (sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "accepted")
    )
    if kind not in ("prompt", "models", "decision") or path not in (
        "accepted",
        "rejected",
        "insufficient",
        "interrupted",
        "regression",
    ):
        raise SystemExit(
            "Usage: autonomous_demo.py prompt|models|decision accepted|rejected|insufficient|interrupted|regression"
        )
    print(json.dumps(asyncio.run(run_demo(kind, path)), indent=2))
