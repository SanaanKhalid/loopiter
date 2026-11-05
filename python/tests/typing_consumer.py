"""Public-API sample for the basic mypy job.

Run from the repository root, after installing the package::

    python -m mypy --follow-imports=silent --python-version 3.11 python/tests/typing_consumer.py

``--follow-imports=silent`` typechecks this consumer against the published
annotations and suppresses errors inside the library. Helpers such as
``validate_policy`` are still loosely annotated; a package-wide strict check is a
follow-up, not part of this job. This module is not collected by unittest.
"""

from __future__ import annotations

from typing import Any

from loopiter import (
    CallbackContext,
    DeploymentAdapter,
    FeedbackLoop,
    ImprovementController,
    ImprovementWorkflow,
    InMemoryStore,
    LoopiterError,
    __version__,
    assign_cohort,
    fingerprint,
    validate_policy,
)


class MemoryDeployment:
    """Minimal adapter shape accepted by the deployment protocol."""

    async def apply(self, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "attempt_id": request["idempotency_key"],
            "artifact_version": request["candidate"]["id"],
            "previous_artifact_version": request["attempt"]["expected_artifact_version"],
        }

    async def inspect(self, request: dict[str, Any]) -> dict[str, Any]:
        return {"status": "unknown", "idempotency_key": request["idempotency_key"]}

    async def rollback(self, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "attempt_id": request["idempotency_key"],
            "artifact_version": request["attempt"]["restore_artifact_version"],
            "previous_artifact_version": request["attempt"]["expected_artifact_version"],
        }


def require_adapter(adapter: DeploymentAdapter) -> DeploymentAdapter:
    return adapter


def package_version() -> str:
    return __version__


def stable_id(value: dict[str, Any]) -> str:
    return fingerprint(value)


def cohort_name() -> str:
    assigned = assign_cohort(
        experiment_id="support",
        entity_id="customer-1",
        salt="private-salt",
        exposure=0.25,
    )
    return str(assigned["cohort"])


def operation_id(ctx: CallbackContext) -> str:
    return ctx.operation_id


def error_code(error: LoopiterError) -> str:
    return error.code


def reject_policy(policy: dict[str, Any]) -> None:
    # Intentionally untyped at the definition; callers still pass a plain dict.
    validate_policy(policy)


async def _unused(*_args: object, **_kwargs: object) -> dict[str, Any]:
    return {}


def review_first(
    loop: FeedbackLoop, policy: dict[str, Any], adapter: DeploymentAdapter
) -> ImprovementController:
    workflow = ImprovementWorkflow(
        id="support",
        version="1",
        optimizer_version="1",
        evaluator_version="1",
        policy=policy,
        dataset=_unused,
        artifact=_unused,
        propose=_unused,
        evaluate=_unused,
        deployment=adapter,
        observe=_unused,
    )
    controller = ImprovementController(loop, workflows=[workflow])
    assert controller.self_improving is False
    assert controller.mode == "recommend"
    return controller


async def capture(loop: FeedbackLoop) -> list[dict[str, Any]]:
    execution = await loop.record_execution(
        id="request-123",
        kind="prediction",
        episode_id="ticket-123",
        input={"text": "Please explain this charge."},
        output={"label": "other"},
        metadata={"intent": "billing"},
    )
    await loop.record_signal(
        id="review-123",
        execution_id=str(execution["id"]),
        kind="correction",
        name="verified_correct",
        value=False,
        correction={"label": "billing"},
        source="authorized-reviewer",
        confidence=1,
    )
    findings = await loop.analyze(
        dimensions=["metadata.intent"],
        minimum_support=1,
        minimum_scored_count=1,
    )
    await loop.close()
    return findings


def open_loop() -> FeedbackLoop:
    return FeedbackLoop(store=InMemoryStore(), namespace="support/dev")
