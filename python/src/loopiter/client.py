"""Review-first lifecycle coordination; external callbacks never run in a DB transaction."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any, Protocol
from uuid import uuid4

from . import _validation as v
from .store import FeedbackStore, StoreTransaction, page_options

Record = v.Record
_UNSET = object()
_callbacks: set[asyncio.Task] = set()


class DeploymentAdapter(Protocol):
    """All operations must be durable and idempotent by request['idempotency_key'].

    inspect returns applied + receipt, unknown, or *fenced* not_applied. Fenced means
    a previous/late apply can NEVER take effect afterward. Rollback is a real change.
    Compare expected_artifact_version atomically in your infrastructure.
    """

    async def apply(self, request: Record) -> Record: ...
    async def rollback(self, request: Record) -> Record: ...
    async def inspect(self, request: Record) -> Record: ...


async def _callback(operation: Callable[[asyncio.Event], Awaitable[Any]], timeout: float) -> Any:  # noqa: ASYNC109
    # wait(), not wait_for(): a callback can suppress cancellation. Never persist its late result.
    cancellation = asyncio.Event()

    async def invoke():
        return await operation(cancellation)

    task = asyncio.create_task(invoke())
    _callbacks.add(task)  # Keep even a cancellation-suppressing callback alive until it exits.

    def finished(t):
        _callbacks.discard(t)
        if not t.cancelled():
            t.exception()  # Consume failures from ignored late results.

    task.add_done_callback(finished)
    try:
        done, _ = await asyncio.wait({task}, timeout=timeout)
        if not done:
            raise v.LoopiterError("timeout", "Callback deadline exceeded.")
        return task.result()
    finally:
        if not task.done():
            cancellation.set()
            task.cancel()


class FeedbackLoop:
    def __init__(
        self,
        *,
        store: FeedbackStore,
        namespace: str,
        maximum_payload_bytes: int = 262144,
        callback_timeout: float = 120,
        sanitize: Callable[[Any], Awaitable[Any]] | None = None,
        deployments_enabled: Callable[[], bool] | None = None,
    ):
        v.nonempty(namespace, "namespace")
        if type(getattr(store, "version", None)) is not int or store.version != 1:
            v.fail("invalid_input", "Python FeedbackStore contract version 1 required.")
        for name in ("transaction", "delete_namespace", "close"):
            if not callable(getattr(store, name, None)):
                v.fail("invalid_input", f"Store missing {name}.")
        v.integer(maximum_payload_bytes, "maximum_payload_bytes")
        v.finite(callback_timeout, "callback_timeout", 0)
        if callback_timeout <= 0:
            v.fail("invalid_input", "callback_timeout must be positive seconds.")
        for hook in (sanitize, deployments_enabled):
            if hook is not None and not callable(hook):
                v.fail("invalid_input", "Hooks must be callable.")
        self._store, self._namespace = store, namespace
        self.maximum_payload_bytes, self.callback_timeout = maximum_payload_bytes, callback_timeout
        self.sanitize, self.deployments_enabled = sanitize, deployments_enabled

    @property
    def namespace(self) -> str:
        return self._namespace

    @property
    def store(self) -> FeedbackStore:
        return self._store

    def _base(self, prefix: str, key: str | None = None) -> Record:
        now = v.now()
        return {
            "id": key or f"{prefix}_{uuid4()}",
            "namespace": self.namespace,
            "revision": 1,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def _next(row: Record, **updates) -> Record:
        result = deepcopy(row)
        result.update(updates)
        result.update(revision=row["revision"] + 1, updated_at=max(v.now(), row["updated_at"]))
        return result

    async def _prepare(self, raw: Any) -> Any:
        v.json_value(raw, self.maximum_payload_bytes)
        value = deepcopy(raw)
        if self.sanitize is not None:
            value = await _callback(lambda _: self.sanitize(value), self.callback_timeout)
        v.json_value(value, self.maximum_payload_bytes)
        return deepcopy(value)

    async def _read(
        self, tx: StoreTransaction, kind: str, key: str, *, required=False
    ) -> Record | None:
        v.nonempty(key, "id")
        row = await tx.get(kind, key)
        if row is not None:
            v.stored(kind, row, self.namespace)
            if row["id"] != key:
                v.fail("integrity_error", "Adapter returned another ID.")
            return deepcopy(row)
        if required:
            v.fail("not_found", f"{kind} record not found.")
        return None

    async def _event(self, tx: StoreTransaction, type_: str, key: str, **details) -> None:
        await tx.insert(
            "events", {**self._base("event"), "type": type_, "subject_id": key, "details": details}
        )

    async def list(
        self,
        collection: str,
        *,
        limit: int = 100,
        cursor: str | None = None,
        window: Record | None = None,
    ) -> Record:
        v.enum(collection, v.COLLECTIONS, "collection")
        page_options(limit, cursor, window)
        async with self.store.transaction(self.namespace) as tx:
            return self._page(
                collection,
                await tx.list(collection, limit=limit, cursor=cursor, window=window),
                limit,
                cursor,
            )

    def _page(self, kind: str, page: Any, limit: int, cursor: str | None) -> Record:
        v.fields(page, ["items", "next_cursor"], ("items",))
        if type(page["items"]) is not list or len(page["items"]) > limit:
            v.fail("integrity_error", "Invalid adapter page size.")
        previous = cursor
        for row in page["items"]:
            v.stored(kind, row, self.namespace)
            if previous is not None and row["id"] <= previous:
                v.fail("integrity_error", "Duplicate or non-progressing adapter page.")
            previous = row["id"]
        if "next_cursor" in page:
            v.nonempty(page["next_cursor"], "next_cursor")
            if not page["items"] or page["next_cursor"] != previous:
                v.fail("integrity_error", "Cursor must identify last returned record.")
        return deepcopy(page)

    async def get_execution(self, key: str) -> Record | None:
        async with self.store.transaction(self.namespace) as tx:
            return await self._read(tx, "executions", key)

    async def get_candidate(self, key: str) -> Record | None:
        async with self.store.transaction(self.namespace) as tx:
            return await self._read(tx, "candidates", key)

    async def get_active_candidate(self, target: Record) -> Record | None:
        v.target(target)
        async with self.store.transaction(self.namespace) as tx:
            state = await self._read(tx, "targets", v.fingerprint(target))
            if state and state.get("active_candidate_id"):
                return await self._read(
                    tx, "candidates", state["active_candidate_id"], required=True
                )
            return None

    async def _insert_input(self, tx: StoreTransaction, kind: str, row: Record) -> Record:
        previous = await self._read(tx, kind, row["id"])
        if previous is not None:
            if previous["input_hash"] != row["input_hash"]:
                v.fail("conflict", "ID already exists with different input.")
            return previous
        await tx.insert(kind, row)
        return deepcopy(row)

    async def record_execution(self, **input_) -> Record:
        v.execution_input(input_)
        data = await self._prepare(input_)
        v.execution_input(data)
        row = {
            **self._base("execution", data.get("id")),
            "artifacts": {},
            "metadata": {},
            "started_at": v.now(),
            **data,
            "input_hash": v.fingerprint(data),
        }
        v.stored("executions", row, self.namespace)
        async with self.store.transaction(self.namespace) as tx:
            if data.get("parent_execution_id"):
                parent = await self._read(
                    tx, "executions", data["parent_execution_id"], required=True
                )
                if parent.get("episode_id") != data.get("episode_id"):
                    v.fail("invalid_input", "Parent and child must share the episode.")
            return await self._insert_input(tx, "executions", row)

    async def complete_execution(self, key: str, *, expected_revision: int, **input_) -> Record:
        v.integer(expected_revision, "expected_revision")
        v.fields(input_, ["output", "metadata", "completed_at"])
        data = await self._prepare(input_)
        v.fields(data, ["output", "metadata", "completed_at"])
        if "metadata" in data:
            v.obj(data["metadata"], "metadata")
        async with self.store.transaction(self.namespace) as tx:
            row = await self._read(tx, "executions", key, required=True)
            updated = self._next(row, **data)
            updated["metadata"] = {**row["metadata"], **data.get("metadata", {})}
            updated["completed_at"] = data.get("completed_at", v.now())
            v.stored("executions", updated, self.namespace)
            await tx.replace("executions", updated, expected_revision)
            return updated

    async def record_signal(self, **input_) -> Record:
        v.signal_input(input_)
        data = await self._prepare(input_)
        v.signal_input(data)
        row = {
            **self._base("signal", data.get("id")),
            "confidence": 1,
            "metadata": {},
            "observed_at": v.now(),
            **data,
            "input_hash": v.fingerprint(data),
        }
        async with self.store.transaction(self.namespace) as tx:
            if data.get("execution_id"):
                execution = await self._read(tx, "executions", data["execution_id"], required=True)
                if "episode_id" in data and data["episode_id"] != execution.get("episode_id"):
                    v.fail("invalid_input", "Signal and execution episodes differ.")
            return await self._insert_input(tx, "signals", row)

    async def create_candidate(self, **input_) -> Record:
        v.candidate_input(input_)
        data = await self._prepare(input_)
        v.candidate_input(data)
        row = {
            **self._base("candidate", data.get("id")),
            "risk": "medium",
            "metadata": {},
            **data,
            "input_hash": v.fingerprint(data),
            "evidence_hash": v.fingerprint(data["evidence"]),
            "status": "proposed",
            "evaluations": [],
        }
        row["content_hash"] = v.content_hash(row)
        async with self.store.transaction(self.namespace) as tx:
            exists = await self._read(tx, "candidates", row["id"])
            result = await self._insert_input(tx, "candidates", row)
            if exists is None:
                await self._event(tx, "candidate.created", row["id"])
            return result

    async def _unlocked(self, tx: StoreTransaction, candidate: Record) -> None:
        state = await self._read(tx, "targets", v.fingerprint(candidate["target"]))
        if state and state.get("pending_attempt_id"):
            raise v.LoopiterError(
                "deployment_pending",
                "Target requires reconciliation.",
                attempt_id=state["pending_attempt_id"],
            )

    async def evaluate_candidate(
        self,
        key: str,
        evaluator: Callable[[Record, asyncio.Event], Awaitable[Record]],
        *,
        evaluator_name: str,
        version: str,
        dataset_hash: str,
    ) -> Record:
        for name, value in (
            ("evaluator_name", evaluator_name),
            ("version", version),
            ("dataset_hash", dataset_hash),
        ):
            v.nonempty(value, name)
        if not callable(evaluator):
            v.fail("invalid_input", "evaluator must be an async callable.")
        async with self.store.transaction(self.namespace) as tx:
            snapshot = await self._read(tx, "candidates", key, required=True)
            await self._unlocked(tx, snapshot)
            if snapshot["status"] not in ("proposed", "evaluated"):
                v.fail("conflict", "Candidate is no longer evaluable.")
        result = await _callback(
            lambda cancel: evaluator(deepcopy(snapshot), cancel), self.callback_timeout
        )
        v.evaluation(result)
        result = await self._prepare(result)
        v.evaluation(result)
        async with self.store.transaction(self.namespace) as tx:
            current = await self._read(tx, "candidates", key, required=True)
            await self._unlocked(tx, current)
            if current["revision"] != snapshot["revision"]:
                v.fail("conflict", "Late evaluation ignored after a state change.")
            evaluation = {
                **result,
                "id": f"evaluation_{uuid4()}",
                "candidate_hash": current["content_hash"],
                "evidence_hash": current["evidence_hash"],
                "evaluator": evaluator_name,
                "version": version,
                "dataset_hash": dataset_hash,
                "created_at": v.now(),
            }
            updated = self._next(
                current, status="evaluated", evaluations=[*current["evaluations"], evaluation]
            )
            await tx.replace("candidates", updated, current["revision"])
            await self._event(
                tx,
                "candidate.evaluated",
                key,
                evaluation_id=evaluation["id"],
                passed=result["passed"],
            )
            return updated

    async def approve_candidate(self, key: str, *, actor: str, evaluation_id: str) -> Record:
        v.nonempty(actor, "actor")
        v.nonempty(evaluation_id, "evaluation_id")
        async with self.store.transaction(self.namespace) as tx:
            current = await self._read(tx, "candidates", key, required=True)
            await self._unlocked(tx, current)
            latest = current["evaluations"][-1] if current["evaluations"] else {}
            if (
                current["status"] != "evaluated"
                or not latest.get("passed")
                or latest["id"] != evaluation_id
            ):
                v.fail("conflict", "Approval requires the latest passing evaluation.")
            updated = self._next(
                current,
                status="approved",
                approval={
                    "actor": actor,
                    "evaluation_id": evaluation_id,
                    "candidate_hash": current["content_hash"],
                    "approved_at": v.now(),
                },
            )
            await tx.replace("candidates", updated, current["revision"])
            await self._event(
                tx, "candidate.approved", key, actor=actor, evaluation_id=evaluation_id
            )
            return updated

    async def reject_candidate(self, key: str, *, reason: str) -> Record:
        v.nonempty(reason, "reason")
        details = await self._prepare({"reason": reason})
        v.fields(details, ["reason"], ("reason",))
        v.nonempty(details["reason"], "reason")
        async with self.store.transaction(self.namespace) as tx:
            current = await self._read(tx, "candidates", key, required=True)
            await self._unlocked(tx, current)
            if current["status"] not in ("proposed", "evaluated", "approved"):
                v.fail("conflict", "Candidate cannot be rejected in this state.")
            updated = self._next(current, status="rejected")
            updated.pop("approval", None)
            await tx.replace("candidates", updated, current["revision"])
            await self._event(tx, "candidate.rejected", key, **details)
            return updated

    @staticmethod
    def _adapter(adapter: DeploymentAdapter) -> None:
        if any(
            not callable(getattr(adapter, name, None)) for name in ("apply", "inspect", "rollback")
        ):
            v.fail("invalid_input", "DeploymentAdapter requires apply, inspect and rollback.")

    def _enabled(self) -> None:
        if self.deployments_enabled is not None and self.deployments_enabled() is not True:
            v.fail(
                "deployment_disabled", "New deployments are disabled. Recovery remains available."
            )

    async def deploy_candidate(
        self, key: str, adapter: DeploymentAdapter, *, expected_artifact_version: Any = _UNSET
    ) -> Record:
        return await self._start(key, adapter, "apply", expected_artifact_version)

    async def rollback_candidate(self, key: str, adapter: DeploymentAdapter) -> Record:
        return await self._start(key, adapter, "rollback", _UNSET)

    async def _start(
        self, key: str, adapter: DeploymentAdapter, operation: str, expected: Any
    ) -> Record:
        self._adapter(adapter)
        if expected is not _UNSET and expected is not None:
            v.nonempty(expected, "expected_artifact_version")
        async with self.store.transaction(self.namespace) as tx:
            if operation == "apply":
                self._enabled()
            candidate = await self._read(tx, "candidates", key, required=True)
            target_id = v.fingerprint(candidate["target"])
            previous = await self._read(tx, "targets", target_id)
            await self._unlocked(tx, candidate)
            if operation == "apply" and candidate["status"] != "approved":
                v.fail("conflict", "Deployment requires an approved candidate.")
            if operation == "rollback" and (
                candidate["status"] != "deployed"
                or not previous
                or previous.get("active_candidate_id") != key
                or "deployment_receipt" not in candidate
            ):
                v.fail("conflict", "Rollback requires the currently deployed candidate.")
            version = (
                previous.get("artifact_version")
                if previous and "artifact_version" in previous
                else (None if expected is _UNSET else expected)
            )
            if expected is not _UNSET and version != expected:
                v.fail("conflict", "Active artifact version differs from expected version.")
            attempt = {
                **self._base("attempt"),
                "target": candidate["target"],
                "candidate_id": key,
                "operation": operation,
                "status": "pending",
                "expected_artifact_version": version,
            }
            if previous and previous.get("active_candidate_id"):
                attempt["previous_candidate_id"] = previous["active_candidate_id"]
            if operation == "rollback":
                attempt["restore_artifact_version"] = candidate["deployment_receipt"][
                    "previous_artifact_version"
                ]
                if candidate.get("predecessor_id"):
                    restore = await self._read(
                        tx, "candidates", candidate["predecessor_id"], required=True
                    )
                    if restore["status"] != "superseded":
                        v.fail("conflict", "Predecessor is not restorable.")
                    attempt["restore_candidate_id"] = restore["id"]
            state = (
                self._next(previous)
                if previous
                else {**self._base("target", target_id), "target": candidate["target"]}
            )
            state["pending_attempt_id"] = attempt["id"]
            await tx.insert("attempts", attempt)
            if previous:
                await tx.replace("targets", state, previous["revision"])
            else:
                await tx.insert("targets", state)
            await self._event(
                tx, "deployment.pending", key, attempt_id=attempt["id"], operation=operation
            )
        return await self._execute(attempt, adapter, inspect_only=False)

    async def reconcile_deployment(self, attempt_id: str, adapter: DeploymentAdapter) -> Record:
        self._adapter(adapter)
        async with self.store.transaction(self.namespace) as tx:
            attempt = await self._read(tx, "attempts", attempt_id, required=True)
        if attempt["status"] != "pending":
            return attempt
        return await self._execute(attempt, adapter, inspect_only=True)

    async def _execute(
        self, attempt: Record, adapter: DeploymentAdapter, *, inspect_only: bool
    ) -> Record:
        try:
            async with self.store.transaction(self.namespace) as tx:
                candidate = await self._read(
                    tx, "candidates", attempt["candidate_id"], required=True
                )
                restore = (
                    await self._read(
                        tx, "candidates", attempt["restore_candidate_id"], required=True
                    )
                    if attempt.get("restore_candidate_id")
                    else None
                )

            async def invoke(cancel):
                request = {
                    "attempt": deepcopy(attempt),
                    "candidate": deepcopy(candidate),
                    "restore_candidate": deepcopy(restore),
                    "idempotency_key": attempt["id"],
                    "cancellation": cancel,
                }
                if inspect_only:
                    return await adapter.inspect(request)
                if attempt["operation"] == "apply":
                    self._enabled()
                result = await getattr(adapter, attempt["operation"])(request)
                return {"status": "applied", "receipt": result}

            result = await _callback(invoke, self.callback_timeout)
            v.fields(result, ["status", "receipt"], ("status",))
            v.enum(result["status"], ["applied", "unknown", "not_applied"], "inspection status")
            if result["status"] == "unknown":
                return attempt
            if result["status"] == "applied" and "receipt" not in result:
                v.fail("integrity_error", "Applied inspection requires a receipt.")
            if result["status"] == "not_applied" and "receipt" in result:
                v.fail("integrity_error", "not_applied cannot include a receipt.")
            return await self._finalize(attempt["id"], result.get("receipt"))
        except asyncio.CancelledError:
            # Attempt already persisted. Caller cancellation never clears target reservation.
            raise
        except Exception as exc:
            raise v.LoopiterError(
                "deployment_pending",
                "Outcome uncertain; reconcile this attempt before changing the target.",
                attempt_id=attempt["id"],
            ) from exc

    async def _finalize(self, key: str, receipt: Record | None) -> Record:
        if receipt is not None:
            v.receipt(receipt)
            original = {
                k: receipt[k]
                for k in ("attempt_id", "artifact_version", "previous_artifact_version")
            }
            receipt = await self._prepare(receipt)
            v.receipt(receipt)
            if any(receipt[k] != value for k, value in original.items()):
                v.fail("integrity_error", "Sanitizer must not change deployment identities.")
        async with self.store.transaction(self.namespace) as tx:
            attempt = await self._read(tx, "attempts", key, required=True)
            if attempt["status"] != "pending":
                if attempt.get("receipt") != receipt:
                    v.fail("conflict", "Conflicting reconciliation result.")
                return attempt
            state = await self._read(tx, "targets", v.fingerprint(attempt["target"]), required=True)
            if state.get("pending_attempt_id") != key:
                v.fail("conflict", "Target reservation changed.")
            updated_state = self._next(state)
            updated_state.pop("pending_attempt_id")
            updated_attempt = self._next(attempt, status="succeeded" if receipt else "not_applied")
            if receipt is not None:
                if (
                    receipt["attempt_id"] != key
                    or receipt["previous_artifact_version"] != attempt["expected_artifact_version"]
                ):
                    v.fail("integrity_error", "Receipt does not match reserved attempt.")
                if attempt["operation"] == "apply" and receipt["artifact_version"] is None:
                    v.fail("integrity_error", "Apply requires a concrete artifact version.")
                if (
                    attempt["operation"] == "rollback"
                    and receipt["artifact_version"] != attempt["restore_artifact_version"]
                ):
                    v.fail("integrity_error", "Rollback restored the wrong version.")
                candidate = await self._read(
                    tx, "candidates", attempt["candidate_id"], required=True
                )
                updated = self._next(candidate)
                if attempt["operation"] == "apply":
                    if candidate["status"] != "approved":
                        v.fail("conflict", "Candidate approval changed during deployment.")
                    updated.update(status="deployed", deployment_receipt=receipt)
                    if attempt.get("previous_candidate_id"):
                        previous = await self._read(
                            tx, "candidates", attempt["previous_candidate_id"], required=True
                        )
                        if previous["status"] != "deployed":
                            v.fail("conflict", "Active predecessor changed.")
                        await tx.replace(
                            "candidates",
                            self._next(previous, status="superseded"),
                            previous["revision"],
                        )
                        updated["predecessor_id"] = previous["id"]
                    updated_state["active_candidate_id"] = candidate["id"]
                else:
                    if (
                        candidate["status"] != "deployed"
                        or state.get("active_candidate_id") != candidate["id"]
                    ):
                        v.fail("conflict", "Active candidate changed during rollback.")
                    updated["status"] = "rolled_back"
                    updated_state.pop("active_candidate_id", None)
                    if attempt.get("restore_candidate_id"):
                        restore = await self._read(
                            tx, "candidates", attempt["restore_candidate_id"], required=True
                        )
                        if restore["status"] != "superseded":
                            v.fail("conflict", "Cannot restore an already rolled-back predecessor.")
                        await tx.replace(
                            "candidates",
                            self._next(restore, status="deployed"),
                            restore["revision"],
                        )
                        updated_state["active_candidate_id"] = restore["id"]
                await tx.replace("candidates", updated, candidate["revision"])
                updated_state["artifact_version"] = receipt["artifact_version"]
                updated_attempt["receipt"] = receipt
            await tx.replace("targets", updated_state, state["revision"])
            await tx.replace("attempts", updated_attempt, attempt["revision"])
            await self._event(
                tx,
                f"deployment.{updated_attempt['status']}",
                attempt["candidate_id"],
                attempt_id=key,
                operation=attempt["operation"],
            )
            return updated_attempt

    async def analyze(self, **options) -> list[Record]:
        from .analysis import analyze

        return await analyze(self, **options)

    async def delete_namespace(self, *, confirmation: str) -> None:
        if confirmation != self.namespace:
            v.fail("invalid_input", "Confirm namespace exactly before deletion.")
        await self.store.delete_namespace(self.namespace)

    async def close(self) -> None:
        await self.store.close()
