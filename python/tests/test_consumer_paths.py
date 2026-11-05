"""In-memory consumer paths for the Loopiter Python SDK.

These tests stay on InMemoryStore. PostgreSQL coverage remains in
``test_postgres.py`` and ``test_autonomy_postgres.py``, which skip unless
``LOOPITER_PYTHON_TEST_DATABASE_URL`` points at a disposable database.
"""

import asyncio
import json
import re
import tomllib
import unittest
from copy import deepcopy
from importlib.metadata import version as installed_version
from pathlib import Path

import loopiter
from loopiter import (
    CallbackContext,
    DeploymentAdapter,
    FeedbackLoop,
    FeedbackStore,
    ImprovementController,
    ImprovementWorkflow,
    InMemoryStore,
    LoopiterError,
    StoreTransaction,
    assign_cohort,
    compare,
    fingerprint,
    prepare_dataset,
    validate_change,
    validate_policy,
)

TARGET = {"kind": "prompt", "key": "support"}
PUBLIC_EXPORTS = [
    "DeploymentAdapter",
    "FeedbackLoop",
    "FeedbackStore",
    "InMemoryStore",
    "LoopiterError",
    "StoreTransaction",
    "fingerprint",
    "assign_cohort",
    "CallbackContext",
    "ImprovementController",
    "ImprovementWorkflow",
    "compare",
    "prepare_dataset",
    "validate_change",
    "validate_policy",
]


def _snake(value):
    if isinstance(value, list):
        return [_snake(item) for item in value]
    if isinstance(value, dict):
        # JSON Schema keywords inside changeSchema keep their published spelling.
        return {
            re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): (
                child if key == "changeSchema" else _snake(child)
            )
            for key, child in value.items()
        }
    return value


POLICY = _snake(json.loads((Path(__file__).parent / "fixtures" / "autonomy.json").read_text()))[
    "policy"
]


class _CodedError:
    def __init__(self, test, code):
        self.test = test
        self.code = code
        self.exception = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.test.assertIsInstance(exc, LoopiterError)
        self.test.assertEqual(exc.code, self.code)
        self.exception = exc
        return True


class RecordingDeployment:
    """In-process adapter: durable by idempotency key, with real rollback."""

    def __init__(self):
        self.version = None
        self.receipts = {}
        self.calls = []

    async def apply(self, request):
        self.calls.append("apply")
        return await self._change(request, request["candidate"]["id"])

    async def rollback(self, request):
        self.calls.append("rollback")
        return await self._change(request, request["attempt"]["restore_artifact_version"])

    async def _change(self, request, version):
        key = request["idempotency_key"]
        if key in self.receipts:
            return self.receipts[key]
        if self.version != request["attempt"]["expected_artifact_version"]:
            raise RuntimeError("External version conflict")
        receipt = {
            "attempt_id": key,
            "artifact_version": version,
            "previous_artifact_version": self.version,
        }
        self.version = version
        self.receipts[key] = receipt
        return receipt

    async def inspect(self, request):
        self.calls.append("inspect")
        receipt = self.receipts.get(request["idempotency_key"])
        if receipt is None:
            return {"status": "unknown"}
        return {"status": "applied", "receipt": receipt}


class GuardDeployment:
    async def apply(self, _request):
        raise AssertionError("apply must not run")

    async def inspect(self, _request):
        raise AssertionError("inspect must not run")

    async def rollback(self, _request):
        raise AssertionError("rollback must not run")


async def _forbidden(*_args, **_kwargs):
    raise AssertionError("fail-closed controller invoked an application callback")


def _workflow(policy, deployment=None):
    return ImprovementWorkflow(
        id="support-prompts",
        version="1",
        optimizer_version="1",
        evaluator_version="1",
        policy=policy,
        dataset=_forbidden,
        artifact=_forbidden,
        propose=_forbidden,
        evaluate=_forbidden,
        deployment=deployment or GuardDeployment(),
        observe=_forbidden,
    )


class PublicSurfaceTests(unittest.TestCase):
    def test_version_exports_and_typed_marker(self):
        package = Path(__file__).resolve().parents[1]
        declared = tomllib.loads((package / "pyproject.toml").read_text())["project"]["version"]
        self.assertEqual(loopiter.__version__, declared)
        self.assertEqual(loopiter.__version__, installed_version("loopiter"))
        exports = {
            "DeploymentAdapter": DeploymentAdapter,
            "FeedbackLoop": FeedbackLoop,
            "FeedbackStore": FeedbackStore,
            "InMemoryStore": InMemoryStore,
            "LoopiterError": LoopiterError,
            "StoreTransaction": StoreTransaction,
            "fingerprint": fingerprint,
            "assign_cohort": assign_cohort,
            "CallbackContext": CallbackContext,
            "ImprovementController": ImprovementController,
            "ImprovementWorkflow": ImprovementWorkflow,
            "compare": compare,
            "prepare_dataset": prepare_dataset,
            "validate_change": validate_change,
            "validate_policy": validate_policy,
        }
        self.assertEqual(loopiter.__all__, PUBLIC_EXPORTS)
        self.assertEqual(list(exports), PUBLIC_EXPORTS)
        for name, obj in exports.items():
            self.assertIs(getattr(loopiter, name), obj)
        marker = Path(loopiter.__file__).resolve().parent / "py.typed"
        self.assertTrue(marker.is_file())


class QuickstartTests(unittest.IsolatedAsyncioTestCase):
    async def test_readme_capture_path(self):
        loop = FeedbackLoop(store=InMemoryStore(), namespace="support/dev")
        execution = await loop.record_execution(
            id="request-123",
            kind="prediction",
            episode_id="ticket-123",
            input={"text": "Please explain this charge."},
            output={"label": "other"},
            artifacts={"model": "your-model-version", "prompt": "intent-v1"},
            metadata={"intent": "billing"},
        )
        signal = await loop.record_signal(
            id="review-123",
            execution_id=execution["id"],
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

        self.assertEqual(execution["id"], "request-123")
        self.assertEqual(signal["id"], "review-123")
        self.assertEqual(signal["execution_id"], execution["id"])
        self.assertEqual(len(findings), 1)
        finding = findings[0]
        self.assertEqual(finding["namespace"], "support/dev")
        self.assertEqual(finding["dimensions"], {"metadata.intent": "billing"})
        self.assertEqual(finding["support"], 1)
        self.assertEqual(finding["mean_score"], 0)
        self.assertEqual(finding["correction_counts"], {'{"label":"billing"}': 1})
        self.assertIsInstance(finding["evidence"]["fingerprint"], str)


class AdapterLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loop = FeedbackLoop(store=InMemoryStore(), namespace="adapter")

    def _error(self, code):
        return _CodedError(self, code)

    async def test_identical_id_retry_and_conflict(self):
        execution = dict(id="request-123", kind="prediction", input={"text": "same"})
        first = await self.loop.record_execution(**execution)
        self.assertEqual(first, await self.loop.record_execution(**execution))
        with self._error("conflict"):
            await self.loop.record_execution(**{**execution, "input": {"text": "different"}})

        signal = dict(
            id="review-123",
            execution_id=first["id"],
            kind="correction",
            name="verified_correct",
            value=False,
            source="authorized-reviewer",
        )
        recorded = await self.loop.record_signal(**signal)
        self.assertEqual(recorded, await self.loop.record_signal(**signal))
        with self._error("conflict"):
            await self.loop.record_signal(**{**signal, "value": True})

        candidate = dict(
            id="prompt-v1",
            target=TARGET,
            proposed_change={"prompt": "v1"},
            evidence={"version": 1},
            risk="low",
        )
        created = await self.loop.create_candidate(**candidate)
        self.assertEqual(created, await self.loop.create_candidate(**candidate))
        with self._error("conflict"):
            await self.loop.create_candidate(**{**candidate, "evidence": {"version": 2}})

    async def test_evaluate_approve_deploy_rollback(self):
        adapter = RecordingDeployment()
        created = await self.loop.create_candidate(
            id="prompt-v2",
            target=TARGET,
            proposed_change={"prompt": "explain the charge"},
            evidence={"version": 1},
            risk="low",
        )

        async def evaluator(_candidate, _cancellation):
            return {"passed": True, "metrics": {"accuracy": 1.0}}

        evaluated = await self.loop.evaluate_candidate(
            created["id"],
            evaluator,
            evaluator_name="exact-match",
            version="1",
            dataset_hash="holdout-1",
        )
        self.assertEqual(evaluated["status"], "evaluated")
        approved = await self.loop.approve_candidate(
            created["id"],
            actor="reviewer",
            evaluation_id=evaluated["evaluations"][-1]["id"],
        )
        self.assertEqual(approved["status"], "approved")

        deployed = await self.loop.deploy_candidate(created["id"], adapter)
        self.assertEqual(deployed["status"], "succeeded")
        self.assertEqual(deployed["operation"], "apply")
        self.assertEqual(adapter.version, created["id"])
        self.assertEqual((await self.loop.get_candidate(created["id"]))["status"], "deployed")
        active = await self.loop.get_active_candidate(TARGET)
        self.assertEqual(active["id"], created["id"])

        rolled = await self.loop.rollback_candidate(created["id"], adapter)
        self.assertEqual(rolled["status"], "succeeded")
        self.assertEqual(rolled["operation"], "rollback")
        self.assertIsNone(adapter.version)
        self.assertEqual((await self.loop.get_candidate(created["id"]))["status"], "rolled_back")
        self.assertIsNone(await self.loop.get_active_candidate(TARGET))
        self.assertEqual(adapter.calls, ["apply", "rollback"])


class ControllerFailClosedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loop = FeedbackLoop(store=InMemoryStore(), namespace="controller")
        self.workflow = _workflow(deepcopy(POLICY))

    def _error(self, code):
        return _CodedError(self, code)

    async def test_defaults_are_review_first(self):
        controller = ImprovementController(self.loop, workflows=[self.workflow])
        self.assertIs(controller.self_improving, False)
        self.assertEqual(controller.mode, "recommend")

    async def test_incomplete_policy_is_rejected(self):
        with self._error("invalid_input"):
            ImprovementController(self.loop, workflows=[_workflow({"version": "incomplete"})])

    async def test_unsafe_fallback_is_rejected(self):
        policy = deepcopy(POLICY)
        policy["on_insufficient_evidence"] = "deploy"
        with self._error("invalid_policy") as error:
            ImprovementController(self.loop, workflows=[_workflow(policy)])
        self.assertIn("unsafe", str(error.exception))

    async def test_autonomous_without_self_improving_stays_paused(self):
        controller = ImprovementController(self.loop, workflows=[self.workflow], mode="autonomous")
        self.assertIs(controller.self_improving, False)
        result = await controller.tick(self.workflow.id)
        self.assertEqual(result["state"], "paused")
        self.assertEqual(result["reason"], "self_improvement_disabled")
        self.assertEqual(result["candidate_ids"], [])
        self.assertIsNone(result["run_id"])


class EdgeErrorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = InMemoryStore()
        self.loop = FeedbackLoop(store=self.store, namespace="edges")

    def _error(self, code):
        return _CodedError(self, code)

    async def test_non_finite_keys_cycles_and_missing_fields(self):
        cycle = []
        cycle.append(cycle)
        cases = {
            "nan": dict(kind="prediction", input=float("nan")),
            "inf": dict(kind="prediction", input=float("inf")),
            "negative-inf": dict(kind="prediction", input=float("-inf")),
            "nested-nan": dict(kind="prediction", input={"score": float("nan")}),
            "non-string-key": dict(kind="prediction", input={1: "bad"}),
            "nested-non-string-key": dict(kind="prediction", input={"nested": {2: "bad"}}),
            "missing-kind": dict(input={"text": "missing kind"}),
            "cycle": dict(kind="prediction", input=cycle),
        }
        for name, data in cases.items():
            with self.subTest(case=name), self._error("invalid_input"):
                await self.loop.record_execution(**data)
        self.assertEqual((await self.loop.list("executions"))["items"], [])

        await self.loop.record_execution(id="e", kind="prediction")
        missing_safety = [
            dict(
                execution_id="e",
                kind="correction",
                name="verified_correct",
                value=False,
            ),
            dict(
                execution_id="e",
                kind="correction",
                name="verified_correct",
                value=False,
                source="",
            ),
            dict(
                execution_id="e",
                kind="correction",
                name="verified_correct",
                source="authorized-reviewer",
            ),
            dict(
                execution_id="e",
                kind="correction",
                name="verified_correct",
                value=float("inf"),
                source="authorized-reviewer",
            ),
        ]
        for data in missing_safety:
            with self.subTest(signal=sorted(data)), self._error("invalid_input"):
                await self.loop.record_signal(**data)
        with self._error("invalid_input"):
            await self.loop.create_candidate(
                target=TARGET, proposed_change={"prompt": "missing evidence"}
            )
        self.assertEqual((await self.loop.list("signals"))["items"], [])

    async def test_payload_limit(self):
        limited = FeedbackLoop(store=self.store, namespace="tiny", maximum_payload_bytes=64)
        with self._error("payload_limit"):
            await limited.record_execution(kind="prediction", input="x" * 200)
        self.assertEqual((await limited.list("executions"))["items"], [])

    async def test_callback_timeout_leaves_candidate_proposed(self):
        loop = FeedbackLoop(store=self.store, namespace="timeout", callback_timeout=0.05)
        await loop.create_candidate(
            id="c", target=TARGET, proposed_change={"prompt": "x"}, evidence={"version": 1}
        )

        async def slow(_candidate, _cancellation):
            await asyncio.sleep(30)
            return {"passed": True}

        with self._error("timeout"):
            await loop.evaluate_candidate(
                "c", slow, evaluator_name="slow", version="1", dataset_hash="holdout"
            )
        candidate = await loop.get_candidate("c")
        self.assertEqual(candidate["status"], "proposed")
        self.assertEqual(candidate["evaluations"], [])

    async def test_cancellation_mid_callback_does_not_persist(self):
        await self.loop.create_candidate(
            id="c", target=TARGET, proposed_change={"prompt": "x"}, evidence={"version": 1}
        )
        started = asyncio.Event()
        observed = {}

        async def slow(_candidate, cancellation):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                observed["cancelled"] = cancellation.is_set()
                raise

        task = asyncio.create_task(
            self.loop.evaluate_candidate(
                "c", slow, evaluator_name="slow", version="1", dataset_hash="holdout"
            )
        )
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        self.assertIs(observed.get("cancelled"), True)
        candidate = await self.loop.get_candidate("c")
        self.assertEqual(candidate["status"], "proposed")
        self.assertEqual(candidate["evaluations"], [])

        async def passing(_candidate, _cancellation):
            return {"passed": True, "metrics": {"accuracy": 1.0}}

        evaluated = await self.loop.evaluate_candidate(
            "c", passing, evaluator_name="exact-match", version="1", dataset_hash="holdout"
        )
        self.assertEqual(evaluated["status"], "evaluated")
        self.assertEqual(len(evaluated["evaluations"]), 1)


if __name__ == "__main__":
    unittest.main()
