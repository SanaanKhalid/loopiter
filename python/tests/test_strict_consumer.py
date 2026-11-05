"""Strict-typed consumer for FeedbackLoop inputs, validate_policy and assign_cohort.

``python/tests/pyrightconfig.json`` sets ``typeCheckingMode`` to strict. Prove it with:

    pyright --project python/tests/pyrightconfig.json
"""

from __future__ import annotations

import unittest
from typing import Literal

from loopiter import (
    AutonomyPolicy,
    CohortAssignment,
    ExecutionInput,
    FeedbackLoop,
    InMemoryStore,
    LoopiterError,
    SignalInput,
    assign_cohort,
    validate_policy,
)
from loopiter.client import CandidateInput, CompleteExecutionInput


def support_policy() -> AutonomyPolicy:
    return {
        "version": "support-policy-v1",
        "target": {"kind": "prompt", "key": "support/intent-guidance"},
        "change_schema": {
            "type": "object",
            "properties": {"fragment": {"type": "string", "maxLength": 2000}},
            "required": ["fragment"],
            "additionalProperties": False,
        },
        "objective": {
            "metric": "accuracy",
            "direction": "maximize",
            "minimum_improvement": 0.03,
            "range": [0, 1],
            "alpha": 0.05,
        },
        "guardrails": [
            {"metric": "accuracy:billing", "comparator": "gte", "value": 0.90},
            {"metric": "accuracy:access", "comparator": "gte", "value": 0.90},
            {"metric": "maxLatencyMs", "comparator": "lte", "value": 2500},
        ],
        "trusted_sources": ["support-reviewer-v1"],
        "minimum_new_units": 30,
        "minimum_validation_units": 150,
        "minimum_audit_units": 500,
        "outcome_maturity_ms": 86_400_000,
        "maximum_rows": 5000,
        "daily": {"model_requests": 5000, "tokens": 5_000_000, "deployments": 1},
        "callback_reservation": {"model_requests": 1200, "tokens": 1_200_000},
        "cooldown_ms": 86_400_000,
        "rollout": {"mode": "immediate"},
        "observation": {
            "minimum_duration_ms": 86_400_000,
            "timeout_ms": 604_800_000,
            "minimum_units": 200,
            "guardrails": [
                {"metric": "errorRate", "comparator": "lte", "value": 0.10},
                {"metric": "telemetryCoverage", "comparator": "gte", "value": 0.99},
            ],
            "on_timeout": "rollback",
            "on_failure": "rollback",
        },
        "on_insufficient_evidence": "wait",
        "on_uncertain_deployment": "reconcile",
        "maximum_candidates": 3,
        "maximum_proposal_calls": 3,
        "maximum_consecutive_failures": 3,
    }


def execution_input() -> ExecutionInput:
    return {
        "id": "request-123",
        "kind": "prediction",
        "episode_id": "ticket-123",
        "input": {"text": "Please explain this charge."},
        "output": {"label": "other"},
        "artifacts": {"model": "your-model-version", "prompt": "intent-v1"},
        "metadata": {"intent": "billing"},
    }


async def exercise() -> CohortAssignment:
    policy = support_policy()
    validate_policy(policy)
    assignment = assign_cohort(
        experiment_id="intent-v1",
        entity_id="customer-123",
        salt="private-salt",
        exposure=0.1,
    )
    cohort: Literal["candidate", "control"] = assignment["cohort"]
    summary = f"{cohort}:{assignment['method']}:{assignment['entity_fingerprint']}"
    if "sha256-framed-v1" not in summary or len(assignment["entity_fingerprint"]) != 64:
        raise AssertionError(summary)
    if not 0 <= assignment["bucket"] < 1:
        raise AssertionError(assignment["bucket"])

    loop = FeedbackLoop(store=InMemoryStore(), namespace="types/dev")
    try:
        recorded = await loop.record_execution(**execution_input())
        if recorded["id"] != "request-123":
            raise AssertionError(recorded["id"])
        update: CompleteExecutionInput = {
            "output": {"label": "billing"},
            "metadata": {"intent": "billing"},
        }
        completed = await loop.complete_execution("request-123", expected_revision=1, **update)
        if completed["output"] != {"label": "billing"}:
            raise AssertionError(completed["output"])
        signal: SignalInput = {
            "id": "review-123",
            "execution_id": "request-123",
            "kind": "correction",
            "name": "verified_correct",
            "value": False,
            "correction": {"label": "billing"},
            "source": "authorized-reviewer",
            "confidence": 1,
        }
        await loop.record_signal(**signal)
        candidate: CandidateInput = {
            "id": "candidate-1",
            "target": {"kind": "prompt", "key": "support"},
            "proposed_change": {"fragment": "Billing answers first."},
            "evidence": {"source": "typed-consumer"},
            "risk": "low",
        }
        created = await loop.create_candidate(**candidate)
        if created["status"] != "proposed":
            raise AssertionError(created["status"])
    finally:
        await loop.close()

    limited = FeedbackLoop(store=InMemoryStore(), namespace="types/limit", maximum_payload_bytes=64)
    try:
        await limited.record_execution(kind="prediction", input="x" * 80)
    except LoopiterError as error:
        if error.code != "payload_limit":
            raise
    else:
        raise AssertionError("oversized payload must raise payload_limit")
    finally:
        await limited.close()
    return assignment


class StrictConsumerTests(unittest.IsolatedAsyncioTestCase):
    async def test_typed_consumer_matches_runtime(self) -> None:
        assignment = await exercise()
        self.assertEqual(set(assignment), {"cohort", "bucket", "method", "entity_fingerprint"})
        self.assertIsInstance(assignment, dict)
