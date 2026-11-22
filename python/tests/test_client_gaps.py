"""Fail-closed branches in client.py that the happy-path tests do not reach."""

import asyncio
import unittest
from contextlib import asynccontextmanager

from test_core import Registry, approved

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError, fingerprint

TARGET = {"kind": "prompt", "key": "support"}


class VersionOneStore:
    version = 1

    async def transaction(self, _namespace):
        raise AssertionError("transaction")

    async def delete_namespace(self, _namespace):
        raise AssertionError("delete")

    async def close(self):
        return None


class StoreMissingClose:
    version = 2

    async def transaction(self, _namespace):
        raise AssertionError("transaction")

    async def delete_namespace(self, _namespace):
        raise AssertionError("delete")


class LiarStore(InMemoryStore):
    """Return execution rows under a different id than requested."""

    @asynccontextmanager
    async def transaction(self, namespace):
        async with super().transaction(namespace) as tx:
            original = tx.get

            async def get(collection, key):
                row = await original(collection, key)
                if row is not None and collection == "executions":
                    row = {**row, "id": row["id"] + "-other"}
                return row

            tx.get = get
            yield tx


def _patch(loop, collection, key, **fields):
    loop.store._state[loop.namespace][collection][key].update(fields)


class HookRegistry(Registry):
    def __init__(self, hook):
        super().__init__()
        self.hook = hook

    async def apply(self, request):
        self.hook(request)
        return await super().apply(request)

    async def rollback(self, request):
        self.hook(request)
        return await super().rollback(request)


class ClientGapTests(unittest.IsolatedAsyncioTestCase):
    def assert_code(self, caught, code):
        self.assertIsInstance(caught.exception, LoopiterError)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def assert_pending(self, caught, cause):
        error = self.assert_code(caught, "deployment_pending")
        self.assertIsInstance(error.__cause__, LoopiterError)
        self.assertEqual(error.__cause__.code, cause)

    async def test_store_contract_and_parent_episode(self):
        with self.assertRaises(LoopiterError) as caught:
            FeedbackLoop(store=VersionOneStore(), namespace="old")
        self.assert_code(caught, "migration_required")
        with self.assertRaises(LoopiterError) as caught:
            FeedbackLoop(store=StoreMissingClose(), namespace="incomplete")
        error = self.assert_code(caught, "invalid_input")
        self.assertIn("close", str(error))

        loop = FeedbackLoop(store=InMemoryStore(), namespace="parents")
        await loop.record_execution(id="parent", kind="prediction", episode_id="ep-1")
        child = await loop.record_execution(
            id="child",
            kind="prediction",
            episode_id="ep-1",
            parent_execution_id="parent",
        )
        self.assertEqual(child["parent_execution_id"], "parent")
        with self.assertRaises(LoopiterError) as caught:
            await loop.record_execution(
                id="mismatch",
                kind="prediction",
                episode_id="ep-2",
                parent_execution_id="parent",
            )
        self.assert_code(caught, "invalid_input")
        with self.assertRaises(LoopiterError) as caught:
            await loop.record_execution(
                id="orphan", kind="prediction", parent_execution_id="missing"
            )
        self.assert_code(caught, "not_found")

        liar = FeedbackLoop(store=LiarStore(), namespace="liar")
        await liar.record_execution(id="e", kind="prediction")
        with self.assertRaises(LoopiterError) as caught:
            await liar.get_execution("e")
        self.assert_code(caught, "integrity_error")

    async def test_evaluation_and_rejection_gates(self):
        loop = FeedbackLoop(store=InMemoryStore(), namespace="gates")
        await loop.create_candidate(
            id="c", target=TARGET, proposed_change={"prompt": "x"}, evidence={"version": 1}
        )
        with self.assertRaises(LoopiterError) as caught:
            await loop.evaluate_candidate(
                "c", None, evaluator_name="test", version="1", dataset_hash="h"
            )
        self.assert_code(caught, "invalid_input")
        await loop.reject_candidate("c", reason="stop")
        with self.assertRaises(LoopiterError) as caught:
            await loop.evaluate_candidate(
                "c",
                lambda *_args: None,
                evaluator_name="test",
                version="1",
                dataset_hash="h",
            )
        self.assert_code(caught, "conflict")

        await approved(loop, "live")
        await loop.deploy_candidate("live", Registry())
        active = await loop.get_active_candidate(TARGET)
        self.assertEqual(active["id"], "live")
        with self.assertRaises(LoopiterError) as caught:
            await loop.reject_candidate("live", reason="already deployed")
        self.assert_code(caught, "conflict")

    async def test_attempt_reuse_versions_and_predecessor(self):
        loop = FeedbackLoop(store=InMemoryStore(), namespace="attempts")
        await approved(loop, "a")
        registry = Registry()
        registry.fail = "before"
        with self.assertRaises(LoopiterError) as caught:
            await loop.deploy_candidate("a", registry)
        attempt_id = caught.exception.attempt_id
        with self.assertRaises(LoopiterError) as caught:
            await loop.rollback_candidate("a", registry, attempt_id=attempt_id)
        self.assert_code(caught, "conflict")
        registry.fenced.add(attempt_id)
        reconciled = await loop.deploy_candidate("a", registry, attempt_id=attempt_id)
        self.assertEqual(reconciled["status"], "not_applied")

        registry.fail = None
        await loop.deploy_candidate("a", registry)
        await approved(loop, "b")
        with self.assertRaises(LoopiterError) as caught:
            await loop.deploy_candidate("b", registry, expected_artifact_version="nope")
        self.assert_code(caught, "conflict")

        await loop.create_candidate(
            id="stale",
            target=TARGET,
            proposed_change={"prompt": "stale"},
            evidence={"version": 1},
            risk="low",
            baseline={"artifact_version": "not-active", "configuration_hash": "cfg"},
        )

        async def passing(_candidate, _cancellation):
            return {"passed": True}

        evaluated = await loop.evaluate_candidate(
            "stale", passing, evaluator_name="test", version="1", dataset_hash="h"
        )
        await loop.approve_candidate(
            "stale", actor="reviewer", evaluation_id=evaluated["evaluations"][-1]["id"]
        )
        with self.assertRaises(LoopiterError) as caught:
            await loop.deploy_candidate("stale", Registry())
        self.assert_code(caught, "stale_baseline")

        await approved(loop, "second")
        await loop.deploy_candidate("second", registry)
        _patch(loop, "candidates", "a", status="deployed")
        with self.assertRaises(LoopiterError) as caught:
            await loop.rollback_candidate("second", registry)
        self.assert_code(caught, "conflict")

    async def test_autonomy_authorization_fails_closed(self):
        loop = FeedbackLoop(store=InMemoryStore(), namespace="auth")
        await loop.create_candidate(
            id="c", target=TARGET, proposed_change={"prompt": "x"}, evidence={"version": 1}
        )

        async def passing(_candidate, _cancellation):
            return {"passed": True}

        evaluated = await loop.evaluate_candidate(
            "c", passing, evaluator_name="test", version="1", dataset_hash="h"
        )
        evaluation_id = evaluated["evaluations"][-1]["id"]
        now = "2026-06-01T00:00:00Z"
        async with loop.store.transaction(loop.namespace) as tx:
            await tx.insert(
                "runs",
                {
                    "id": "run_1",
                    "namespace": loop.namespace,
                    "revision": 1,
                    "created_at": now,
                    "updated_at": now,
                    "format": 1,
                    "data": {
                        "workflow_id": "wf",
                        "audit_evaluation_id": evaluation_id,
                        "lease_owner": "owner",
                        "lease_until": "2099-01-01T00:00:00Z",
                        "selected_id": "c",
                        "state": "deploying",
                        "definition_hash": "hash",
                    },
                },
            )
            await tx.insert(
                "coordination",
                {
                    "id": "workflow:wf",
                    "namespace": loop.namespace,
                    "revision": 1,
                    "created_at": now,
                    "updated_at": now,
                    "format": 1,
                    "data": {
                        "mode": "recommend",
                        "self_improving": False,
                        "paused": False,
                        "definition_hash": "hash",
                    },
                },
            )
        with self.assertRaises(LoopiterError) as caught:
            await loop.deploy_candidate(
                "c", Registry(), authorization={"run_id": "run_1", "lease_owner": "owner"}
            )
        self.assert_code(caught, "autonomy_not_authorized")

    async def test_inspection_and_receipt_integrity(self):
        loop = FeedbackLoop(store=InMemoryStore(), namespace="receipts")
        await approved(loop)

        class AppliedWithoutReceipt(Registry):
            async def inspect(self, _request):
                return {"status": "applied"}

        class NotAppliedWithReceipt(Registry):
            async def inspect(self, _request):
                return {"status": "not_applied", "receipt": {"attempt_id": "x"}}

        class WrongAttempt(Registry):
            async def apply(self, request):
                return {
                    "attempt_id": "other-attempt",
                    "artifact_version": "v1",
                    "previous_artifact_version": request["attempt"]["expected_artifact_version"],
                }

        class NullVersion(Registry):
            async def apply(self, request):
                return {
                    "attempt_id": request["idempotency_key"],
                    "artifact_version": None,
                    "previous_artifact_version": request["attempt"]["expected_artifact_version"],
                }

        for adapter in (AppliedWithoutReceipt(), NotAppliedWithReceipt()):
            with self.subTest(adapter=type(adapter).__name__):
                fresh = FeedbackLoop(store=InMemoryStore(), namespace=type(adapter).__name__)
                await approved(fresh)
                failing = Registry()
                failing.fail = "before"
                with self.assertRaises(LoopiterError) as caught:
                    await fresh.deploy_candidate("candidate", failing)
                attempt_id = caught.exception.attempt_id
                with self.assertRaises(LoopiterError) as caught:
                    await fresh.reconcile_deployment(attempt_id, adapter)
                self.assert_pending(caught, "integrity_error")
        for adapter in (WrongAttempt(), NullVersion()):
            with self.subTest(adapter=type(adapter).__name__):
                fresh = FeedbackLoop(store=InMemoryStore(), namespace=type(adapter).__name__)
                await approved(fresh)
                with self.assertRaises(LoopiterError) as caught:
                    await fresh.deploy_candidate("candidate", adapter)
                self.assert_pending(caught, "integrity_error")

        async def tamper(value):
            if (
                isinstance(value, dict)
                and "attempt_id" in value
                and "artifact_version" in value
                and value["artifact_version"] is not None
            ):
                return {**value, "artifact_version": value["artifact_version"] + "-tampered"}
            return value

        sanitized = FeedbackLoop(store=InMemoryStore(), namespace="sanitize", sanitize=tamper)
        await approved(sanitized)
        with self.assertRaises(LoopiterError) as caught:
            await sanitized.deploy_candidate("candidate", Registry())
        self.assert_pending(caught, "integrity_error")

    async def test_finalize_sees_concurrent_and_mutated_state(self):
        loop = FeedbackLoop(store=InMemoryStore(), namespace="finalize")
        await approved(loop)
        registry = Registry()
        registry.fail = "before"
        with self.assertRaises(LoopiterError) as caught:
            await loop.deploy_candidate("candidate", registry)
        attempt_id = caught.exception.attempt_id

        class Divergent:
            def __init__(self):
                self.entered = 0
                self.both = asyncio.Event()
                self.release = asyncio.Event()
                self.calls = 0

            async def apply(self, _request):
                raise AssertionError("apply")

            async def rollback(self, _request):
                raise AssertionError("rollback")

            async def inspect(self, request):
                self.entered += 1
                if self.entered >= 2:
                    self.both.set()
                await self.release.wait()
                self.calls += 1
                return {
                    "status": "applied",
                    "receipt": {
                        "attempt_id": request["idempotency_key"],
                        "artifact_version": f"v{self.calls}",
                        "previous_artifact_version": request["attempt"][
                            "expected_artifact_version"
                        ],
                    },
                }

        divergent = Divergent()
        pending = asyncio.gather(
            loop.reconcile_deployment(attempt_id, divergent),
            loop.reconcile_deployment(attempt_id, divergent),
            return_exceptions=True,
        )
        await divergent.both.wait()
        divergent.release.set()
        outcomes = await pending
        self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
        errors = [item for item in outcomes if isinstance(item, LoopiterError)]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].code, "deployment_pending")
        self.assertEqual(errors[0].__cause__.code, "conflict")

        same = FeedbackLoop(store=InMemoryStore(), namespace="same-receipt")
        await approved(same)
        held = Registry()
        held.fail = "after"
        with self.assertRaises(LoopiterError) as caught:
            await same.deploy_candidate("candidate", held)
        gate_attempt = caught.exception.attempt_id
        entered = 0
        both = asyncio.Event()
        release = asyncio.Event()
        original = held.inspect

        async def inspect(request):
            nonlocal entered
            entered += 1
            if entered >= 2:
                both.set()
            await release.wait()
            return await original(request)

        held.inspect = inspect
        waiting = asyncio.gather(
            same.reconcile_deployment(gate_attempt, held),
            same.reconcile_deployment(gate_attempt, held),
        )
        await both.wait()
        release.set()
        reconciled = await waiting
        self.assertEqual({item["status"] for item in reconciled}, {"succeeded"})
        self.assertEqual(reconciled[0]["receipt"], reconciled[1]["receipt"])

        moved = FeedbackLoop(store=InMemoryStore(), namespace="moved")
        await approved(moved)
        failing = Registry()
        failing.fail = "before"
        with self.assertRaises(LoopiterError) as caught:
            await moved.deploy_candidate("candidate", failing)
        attempt_id = caught.exception.attempt_id

        class MoveReservation(Registry):
            async def inspect(self, request):
                target_id = fingerprint(request["candidate"]["target"])
                _patch(
                    moved,
                    "targets",
                    target_id,
                    pending_attempt_id="attempt_other",
                )
                return {"status": "not_applied"}

        with self.assertRaises(LoopiterError) as caught:
            await moved.reconcile_deployment(attempt_id, MoveReservation())
        self.assert_pending(caught, "conflict")

        changed = FeedbackLoop(store=InMemoryStore(), namespace="changed")
        await approved(changed, "a")

        def revoke(_request):
            _patch(changed, "candidates", "a", status="evaluated")

        with self.assertRaises(LoopiterError) as caught:
            await changed.deploy_candidate("a", HookRegistry(revoke))
        self.assert_pending(caught, "conflict")

        lineage = FeedbackLoop(store=InMemoryStore(), namespace="lineage")
        await approved(lineage, "a")
        prior = Registry()
        await lineage.deploy_candidate("a", prior)
        await approved(lineage, "b")

        def retarget(_request):
            _patch(lineage, "candidates", "a", status="rolled_back")

        follow = HookRegistry(retarget)
        follow.version = prior.version
        with self.assertRaises(LoopiterError) as caught:
            await lineage.deploy_candidate("b", follow)
        self.assert_pending(caught, "conflict")

        rolled = FeedbackLoop(store=InMemoryStore(), namespace="rolled")
        await approved(rolled)
        await rolled.deploy_candidate("candidate", Registry())

        class WrongRestore(Registry):
            async def rollback(self, request):
                return {
                    "attempt_id": request["idempotency_key"],
                    "artifact_version": "wrong",
                    "previous_artifact_version": request["attempt"]["expected_artifact_version"],
                }

        with self.assertRaises(LoopiterError) as caught:
            await rolled.rollback_candidate("candidate", WrongRestore())
        self.assert_pending(caught, "integrity_error")

        active = FeedbackLoop(store=InMemoryStore(), namespace="active")
        await approved(active)
        deployed = Registry()
        await active.deploy_candidate("candidate", deployed)

        def demote(_request):
            _patch(active, "candidates", "candidate", status="approved")

        rollback = HookRegistry(demote)
        rollback.version = deployed.version
        with self.assertRaises(LoopiterError) as caught:
            await active.rollback_candidate("candidate", rollback)
        self.assert_pending(caught, "conflict")

        restore = FeedbackLoop(store=InMemoryStore(), namespace="restore")
        await approved(restore, "a")
        first = Registry()
        await restore.deploy_candidate("a", first)
        await approved(restore, "b")
        second = Registry()
        second.version = first.version
        await restore.deploy_candidate("b", second)

        def unrestorable(_request):
            _patch(restore, "candidates", "a", status="rolled_back")

        undo = HookRegistry(unrestorable)
        undo.version = second.version
        with self.assertRaises(LoopiterError) as caught:
            await restore.rollback_candidate("b", undo)
        self.assert_pending(caught, "conflict")


if __name__ == "__main__":
    unittest.main()
