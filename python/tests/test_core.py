import asyncio
import unittest
from contextlib import asynccontextmanager

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError
from loopiter.testing import run_store_conformance

TARGET = {"kind": "prompt", "key": "support"}


class Registry:
    """Test-only external system with idempotent receipts and explicit fencing."""

    def __init__(self):
        self.version = None
        self.receipts = {}
        self.calls = 0
        self.fail = None
        self.fenced = set()

    async def apply(self, request):
        self.calls += 1
        return await self._change(request, request["candidate"]["id"])

    async def rollback(self, request):
        self.calls += 1
        return await self._change(request, request["attempt"]["restore_artifact_version"])

    async def _change(self, request, version):
        key = request["idempotency_key"]
        if key in self.receipts:
            return self.receipts[key]
        if key in self.fenced:
            raise RuntimeError("Fenced attempt")
        if self.fail == "before":
            raise RuntimeError("Before external change")
        if self.version != request["attempt"]["expected_artifact_version"]:
            raise RuntimeError("External version conflict")
        receipt = {
            "attempt_id": key,
            "artifact_version": version,
            "previous_artifact_version": self.version,
        }
        self.version = version
        self.receipts[key] = receipt
        if self.fail == "after":
            raise RuntimeError("Lost external response")
        return receipt

    async def inspect(self, request):
        key = request["idempotency_key"]
        if key in self.receipts:
            return {"status": "applied", "receipt": self.receipts[key]}
        if key in self.fenced:
            return {"status": "not_applied"}
        return {"status": "unknown"}


class FailCommitStore(InMemoryStore):
    """Fail after lifecycle receipt writes but before atomic store commit."""

    armed = False

    @asynccontextmanager
    async def transaction(self, namespace):
        async with super().transaction(namespace) as tx:
            yield tx
            if self.armed and any(
                r["status"] == "succeeded" for r in tx.state.get("attempts", {}).values()
            ):
                self.armed = False
                raise RuntimeError("Injected commit failure")


async def passing(candidate, cancellation):
    return {"passed": True, "metrics": {"accuracy": 1.0}}


async def approved(loop, key="candidate"):
    await loop.create_candidate(
        id=key, target=TARGET, proposed_change={"prompt": key}, evidence={"version": 1}, risk="low"
    )
    candidate = await loop.evaluate_candidate(
        key, passing, evaluator_name="exact-match", version="1", dataset_hash="holdout-1"
    )
    return await loop.approve_candidate(
        key, actor="reviewer", evaluation_id=candidate["evaluations"][-1]["id"]
    )


class CoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = InMemoryStore()
        self.loop = FeedbackLoop(store=self.store, namespace="test")

    def error(self, code):
        class Check:
            def __enter__(inner):
                return inner

            def __exit__(inner, kind, exception, tb):
                self.assertIsInstance(exception, LoopiterError)
                self.assertEqual(exception.code, code)
                inner.exception = exception
                return True

        return Check()

    async def test_store_conformance(self):
        await run_store_conformance(self.store)

    async def test_client_scope_cannot_be_rebound(self):
        with self.assertRaises(AttributeError):
            self.loop.namespace = "other"
        with self.assertRaises(AttributeError):
            self.loop.store = InMemoryStore()

    async def test_late_deployment_after_timeout_is_fenced_by_inspection(self):
        loop = FeedbackLoop(store=self.store, namespace="fence", callback_timeout=0.02)
        await approved(loop)
        release, finished = asyncio.Event(), asyncio.Event()

        class LateRegistry(Registry):
            async def apply(self, request):
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    await release.wait()
                try:
                    return await super().apply(request)
                finally:
                    finished.set()

            async def inspect(self, request):
                key = request["idempotency_key"]
                if key not in self.receipts:
                    self.fenced.add(key)
                return await super().inspect(request)

        registry = LateRegistry()
        with self.error("deployment_pending") as error:
            await loop.deploy_candidate("candidate", registry)
        self.assertEqual(
            (await loop.reconcile_deployment(error.exception.attempt_id, registry))["status"],
            "not_applied",
        )
        release.set()
        await finished.wait()
        self.assertIsNone(registry.version)
        self.assertEqual((await loop.get_candidate("candidate"))["status"], "approved")

    async def test_namespace_and_duplicate_signals_candidates(self):
        await self.loop.record_execution(id="e", kind="prediction", episode_id="ep")
        other = FeedbackLoop(store=self.store, namespace="other")
        with self.error("not_found"):
            await other.record_signal(
                execution_id="e", kind="rating", name="x", value=True, source="test"
            )
        with self.error("invalid_input"):
            await self.loop.record_signal(
                execution_id="e",
                episode_id="different",
                kind="rating",
                name="x",
                value=True,
                source="test",
            )
        data = dict(id="s", execution_id="e", kind="rating", name="x", value=True, source="test")
        signal = await self.loop.record_signal(**data)
        self.assertEqual(signal, await self.loop.record_signal(**data))
        with self.error("conflict"):
            await self.loop.record_signal(**{**data, "value": False})
        data = dict(id="c", target=TARGET, proposed_change={}, evidence={"fingerprint": "1"})
        c = await self.loop.create_candidate(**data)
        self.assertEqual(c, await self.loop.create_candidate(**data))
        with self.error("conflict"):
            await self.loop.create_candidate(**{**data, "evidence": {"fingerprint": "2"}})

    async def test_invalid_input_fails_closed(self):
        cycle = []
        cycle.append(cycle)
        bad_inputs = [
            dict(kind="typo"),
            dict(kind="prediction", namespace="other"),
            dict(kind="prediction", started_at="2026-02-30T00:00:00Z"),
            dict(kind="prediction", metadata=[]),
            dict(kind="prediction", input=float("nan")),
            dict(kind="prediction", input=cycle),
            dict(kind="prediction", input={1: "bad"}),
            dict(kind="prediction", input=(1, 2)),
            dict(kind="prediction", id=""),
            dict(kind="prediction", input=10**400),
        ]
        for data in bad_inputs:
            with self.subTest(data=str(data)[:100]), self.error("invalid_input"):
                await self.loop.record_execution(**data)
        self.assertEqual((await self.loop.list("executions"))["items"], [])
        for settings in (
            dict(callback_timeout=0),
            dict(callback_timeout=float("nan")),
            dict(maximum_payload_bytes=True),
            dict(sanitize=False),
        ):
            with self.error("invalid_input"):
                FeedbackLoop(store=self.store, namespace="test", **settings)

    async def test_sanitizer_and_payload_limits(self):
        async def redact(data):
            data["input"] = "redacted"
            return data

        safe = FeedbackLoop(store=self.store, namespace="safe", sanitize=redact)
        self.assertEqual(
            (await safe.record_execution(kind="prediction", input="secret"))["input"], "redacted"
        )

        async def broken(data):
            raise RuntimeError("Sanitizer failed")

        unsafe = FeedbackLoop(store=self.store, namespace="safe", sanitize=broken)
        with self.assertRaises(RuntimeError):
            await unsafe.record_execution(kind="prediction", input="unsanitized")
        self.assertEqual(len((await safe.list("executions"))["items"]), 1)
        tiny = FeedbackLoop(store=self.store, namespace="tiny", maximum_payload_bytes=32)
        with self.error("payload_limit"):
            await tiny.record_execution(kind="prediction", input="x" * 100)

    async def test_revision_and_temporal_safety(self):
        await self.loop.record_execution(
            id="e", kind="prediction", started_at="2026-01-02T00:00:00Z"
        )
        with self.error("invalid_input"):
            await self.loop.complete_execution(
                "e", expected_revision=1, completed_at="2026-01-01T00:00:00Z"
            )
        await self.loop.complete_execution("e", expected_revision=1, output="ok")
        with self.error("conflict"):
            await self.loop.complete_execution("e", expected_revision=1, output="stale")

    async def test_approval_gate_and_concurrent_approval(self):
        await self.loop.create_candidate(id="c", target=TARGET, proposed_change={}, evidence={})
        with self.error("conflict"):
            await self.loop.approve_candidate("c", actor="human", evaluation_id="missing")

        async def failing(c, cancel):
            return {"passed": False, "metrics": {"accuracy": 0.3}}

        c = await self.loop.evaluate_candidate(
            "c", failing, evaluator_name="test", version="1", dataset_hash="h"
        )
        with self.error("conflict"):
            await self.loop.approve_candidate(
                "c", actor="human", evaluation_id=c["evaluations"][-1]["id"]
            )
        c = await self.loop.evaluate_candidate(
            "c", passing, evaluator_name="test", version="2", dataset_hash="h"
        )
        outcomes = await asyncio.gather(
            *(
                self.loop.approve_candidate("c", actor=a, evaluation_id=c["evaluations"][-1]["id"])
                for a in ("a", "b")
            ),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(o, dict) for o in outcomes), 1)
        self.assertEqual(sum(isinstance(o, LoopiterError) for o in outcomes), 1)

    async def test_stale_evaluation_after_rejection_and_newer_evaluation(self):
        for final in ("reject", "evaluate"):
            await self.loop.create_candidate(
                id=final, target=TARGET, proposed_change={}, evidence={}
            )
            started, release = asyncio.Event(), asyncio.Event()

            async def slow(c, cancel, started=started, release=release):
                started.set()
                await release.wait()
                return {"passed": True}

            task = asyncio.create_task(
                self.loop.evaluate_candidate(
                    final, slow, evaluator_name="slow", version="1", dataset_hash="h"
                )
            )
            await started.wait()
            if final == "reject":
                await self.loop.reject_candidate(final, reason="Reject while evaluator runs")
            else:
                await self.loop.evaluate_candidate(
                    final, passing, evaluator_name="fast", version="2", dataset_hash="h2"
                )
            release.set()
            with self.error("conflict"):
                await task
            self.assertEqual(
                (await self.loop.get_candidate(final))["status"],
                "rejected" if final == "reject" else "evaluated",
            )

    async def test_malformed_evaluations(self):
        await self.loop.create_candidate(id="c", target=TARGET, proposed_change={}, evidence={})
        for result in (
            {},
            {"passed": 1},
            {"passed": True, "metrics": {"accuracy": float("inf")}},
            {"passed": True, "extra": 1},
        ):

            async def evaluator(c, cancel, result=result):
                return result

            with self.error("invalid_input"):
                await self.loop.evaluate_candidate(
                    "c", evaluator, evaluator_name="bad", version="1", dataset_hash="h"
                )
        self.assertEqual((await self.loop.get_candidate("c"))["evaluations"], [])

    async def test_timeout_ignores_late_result(self):
        loop = FeedbackLoop(store=self.store, namespace="test", callback_timeout=0.02)
        await loop.create_candidate(id="c", target=TARGET, proposed_change={}, evidence={})
        release, done = asyncio.Event(), asyncio.Event()

        async def suppress_cancel(c, cancellation):
            try:
                await release.wait()
            except asyncio.CancelledError:
                self.assertTrue(cancellation.is_set())
                await release.wait()
            done.set()
            return {"passed": True}

        with self.error("timeout"):
            await loop.evaluate_candidate(
                "c", suppress_cancel, evaluator_name="late", version="1", dataset_hash="h"
            )
        release.set()
        await done.wait()
        self.assertEqual((await loop.get_candidate("c"))["status"], "proposed")

    async def test_task_cancellation(self):
        await self.loop.create_candidate(id="c", target=TARGET, proposed_change={}, evidence={})
        started = asyncio.Event()

        async def slow(c, cancel):
            started.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(
            self.loop.evaluate_candidate(
                "c", slow, evaluator_name="x", version="1", dataset_hash="h"
            )
        )
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual((await self.loop.get_candidate("c"))["status"], "proposed")

    async def test_apply_and_rollback_lineage(self):
        registry = Registry()
        for key in ("a", "b"):
            await approved(self.loop, key)
            await self.loop.deploy_candidate(key, registry)
        self.assertEqual((await self.loop.get_candidate("a"))["status"], "superseded")
        await self.loop.rollback_candidate("b", registry)
        self.assertEqual(registry.version, "a")
        with self.error("conflict"):
            await self.loop.rollback_candidate("b", registry)
        await self.loop.rollback_candidate("a", registry)
        self.assertIsNone(registry.version)
        self.assertIsNone(await self.loop.get_active_candidate(TARGET))
        with self.error("conflict"):
            await self.loop.deploy_candidate("b", registry)

    async def test_fail_before_change_unknown_and_fenced_recovery(self):
        await approved(self.loop)
        registry = Registry()
        registry.fail = "before"
        with self.error("deployment_pending") as error:
            await self.loop.deploy_candidate("candidate", registry)
        key = error.exception.attempt_id
        self.assertEqual((await self.loop.reconcile_deployment(key, registry))["status"], "pending")
        with self.error("deployment_pending"):
            await self.loop.reject_candidate("candidate", reason="Can't mutate a reserved target")
        registry.fenced.add(key)
        self.assertEqual(
            (await self.loop.reconcile_deployment(key, registry))["status"], "not_applied"
        )
        registry.fail = None
        await self.loop.deploy_candidate("candidate", registry)
        self.assertEqual(registry.calls, 2)

    async def test_lost_receipt_recovery_apply_and_rollback(self):
        await approved(self.loop)
        registry = Registry()
        registry.fail = "after"
        with self.error("deployment_pending") as error:
            await self.loop.deploy_candidate("candidate", registry)
        with self.error("deployment_pending"):
            await self.loop.deploy_candidate("candidate", registry)
        attempt = await self.loop.reconcile_deployment(error.exception.attempt_id, registry)
        self.assertEqual(attempt["status"], "succeeded")
        self.assertEqual(attempt, await self.loop.reconcile_deployment(attempt["id"], registry))
        self.assertEqual(registry.calls, 1)
        with self.error("deployment_pending") as error:
            await self.loop.rollback_candidate("candidate", registry)
        await self.loop.reconcile_deployment(error.exception.attempt_id, registry)
        self.assertIsNone(await self.loop.get_active_candidate(TARGET))

    async def test_receipt_commit_is_atomic(self):
        store = FailCommitStore()
        loop = FeedbackLoop(store=store, namespace="test")
        await approved(loop)
        registry = Registry()
        store.armed = True
        with self.error("deployment_pending") as error:
            await loop.deploy_candidate("candidate", registry)
        self.assertEqual((await loop.get_candidate("candidate"))["status"], "approved")
        self.assertIsNone(await loop.get_active_candidate(TARGET))
        self.assertEqual((await loop.list("attempts"))["items"][0]["status"], "pending")
        await loop.reconcile_deployment(error.exception.attempt_id, registry)
        self.assertEqual((await loop.get_candidate("candidate"))["status"], "deployed")

    async def test_retry_first_deployment_to_existing_external_version(self):
        await approved(self.loop)
        registry = Registry()
        registry.version = "preexisting-v1"
        registry.fail = "before"
        with self.error("deployment_pending") as error:
            await self.loop.deploy_candidate(
                "candidate", registry, expected_artifact_version="preexisting-v1"
            )
        registry.fenced.add(error.exception.attempt_id)
        await self.loop.reconcile_deployment(error.exception.attempt_id, registry)
        registry.fail = None
        await self.loop.deploy_candidate(
            "candidate", registry, expected_artifact_version="preexisting-v1"
        )
        await self.loop.rollback_candidate("candidate", registry)
        self.assertEqual(registry.version, "preexisting-v1")

    async def test_concurrent_deployment_has_one_winner(self):
        await approved(self.loop)
        registry = Registry()
        outcomes = await asyncio.gather(
            *(self.loop.deploy_candidate("candidate", registry) for _ in range(2)),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(o, dict) for o in outcomes), 1)
        self.assertEqual(registry.calls, 1)

    async def test_bad_receipt_and_cancellation_leave_pending(self):
        await approved(self.loop)

        class Bad(Registry):
            async def apply(self, request):
                return {"attempt_id": request["idempotency_key"], "artifact_version": "v2"}

        with self.error("deployment_pending"):
            await self.loop.deploy_candidate("candidate", Bad())
        self.assertEqual((await self.loop.list("attempts"))["items"][0]["status"], "pending")
        other = FeedbackLoop(store=self.store, namespace="cancel")
        await approved(other)
        started = asyncio.Event()

        class Slow(Registry):
            async def apply(self, request):
                started.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(other.deploy_candidate("candidate", Slow()))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual((await other.list("attempts"))["items"][0]["status"], "pending")

    async def test_disable_switch_does_not_block_rollback(self):
        enabled = True
        loop = FeedbackLoop(
            store=self.store, namespace="switch", deployments_enabled=lambda: enabled
        )
        await approved(loop)
        registry = Registry()
        enabled = None
        with self.error("deployment_disabled"):
            await loop.deploy_candidate("candidate", registry)
        enabled = True
        await loop.deploy_candidate("candidate", registry)
        enabled = False
        await loop.rollback_candidate("candidate", registry)

    async def test_tampered_adapter_record_fails_closed(self):
        await approved(self.loop)
        record = self.store._state["test"]["candidates"]["candidate"]
        record["proposed_change"] = {"prompt": "tampered"}
        with self.error("integrity_error"):
            await self.loop.deploy_candidate("candidate", Registry())

    async def test_missing_or_wrong_adapter_and_deletion_confirmation(self):
        with self.error("invalid_input"):
            await self.loop.deploy_candidate("x", object())
        with self.error("invalid_input"):
            await self.loop.delete_namespace(confirmation="other")
        await self.loop.record_execution(id="x", kind="tool")
        with self.error("query_limit"):
            await self.loop.list("executions", limit=1001)


if __name__ == "__main__":
    unittest.main()
