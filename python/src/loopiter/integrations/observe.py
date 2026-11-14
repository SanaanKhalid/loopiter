"""Application observation. The default awaits the store. Bounded capture is opt-in.

with_loopiter sends provider writes through CaptureClient so there is one write path.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any
from uuid import uuid4

from .._validation import LoopiterError
from .privacy import capture_payload


def _json_clone(value: Any) -> Any:
    if value is None or type(value) in (str, int, float, bool):
        return value
    if type(value) is list:
        return [_json_clone(item) for item in value]
    if type(value) is dict:
        return {str(key): _json_clone(item) for key, item in value.items()}
    raise TypeError("Captured values must be JSON serializable.")


def _payload(value: Any, policy: dict[str, Any]) -> tuple[Any, bool]:
    captured = capture_payload(value, policy)
    return captured["value"], captured["truncated"]


def _note(callback: Callable[[Any], None] | None, error: BaseException) -> None:
    if callback is None:
        return
    try:
        callback(error)
    except Exception:
        return


class CaptureClient:
    """Live capture writes. Omit bounded to await each store call."""

    def __init__(
        self,
        loop: Any,
        *,
        on_error: Callable[[Any], None] | None = None,
        failure_mode: str = "open",
        bounded: dict[str, Any] | None = None,
        capture: dict[str, Any] | None = None,
    ):
        if failure_mode not in ("open", "closed"):
            raise TypeError("failure_mode must be open or closed.")
        self.loop = loop
        self.on_error = on_error
        self.failure_mode = failure_mode
        self.policy = {"mode": "metadata-only", **(capture or {})}
        _payload(None, self.policy)
        self._bounded = None
        if bounded is not None:
            if failure_mode == "closed":
                raise TypeError("failure_mode closed cannot be combined with bounded capture.")
            self._bounded = _Bounded(self, bounded)

    async def _persist(self, action: Callable[[], Awaitable[Any]]) -> Any:
        try:
            return await action()
        except Exception as error:
            _note(self.on_error, error)
            if self.failure_mode == "closed":
                raise
            return None

    async def record_execution(self, **kwargs: Any) -> Any:
        if self._bounded is not None:
            return self._bounded.open_record(kwargs)
        return await self._persist(lambda: self.loop.record_execution(**kwargs))

    async def complete_execution(self, key: str, *, expected_revision: int, **kwargs: Any) -> Any:
        if self._bounded is not None:
            self._bounded.finish_record(key, kwargs)
            return None
        return await self._persist(
            lambda: self.loop.complete_execution(key, expected_revision=expected_revision, **kwargs)
        )

    def stats(self) -> dict[str, int]:
        if self._bounded is None:
            raise TypeError("stats() requires bounded capture.")
        return self._bounded.stats()

    async def force_flush(self, timeout_ms: int | None = None) -> None:
        if self._bounded is None:
            raise TypeError("force_flush() requires bounded capture.")
        await self._bounded.force_flush(timeout_ms)

    async def shutdown(self, timeout_ms: int | None = None) -> None:
        if self._bounded is None:
            raise TypeError("shutdown() requires bounded capture.")
        await self._bounded.shutdown(timeout_ms)

    async def observe(
        self,
        name: str,
        operation: Callable[[], Any],
        *,
        context: dict[str, Any] | None = None,
        kind: str = "workflow",
        input: Any = None,
    ) -> Any:
        _check_name(name)
        copied = deepcopy(context or {})
        if self._bounded is None:
            return await self._observe_inline(name, operation, copied, kind, input)
        return await self._bounded.observe(name, operation, copied, kind, input)

    async def _observe_inline(
        self,
        name: str,
        operation: Callable[[], Any],
        context: dict[str, Any],
        kind: str,
        input: Any,
    ) -> Any:
        attempt_id = str(uuid4())
        row: dict[str, Any] | None = None

        async def begin() -> dict[str, Any]:
            if context.get("id") and await self.loop.get_execution(context["id"]):
                raise LoopiterError(
                    "conflict",
                    "Observation already exists; inspect the original result instead of replaying.",
                )
            recorded = await self.loop.record_execution(
                **_record_fields(name, attempt_id, context, kind, input, self.policy, "pending")
            )
            identity = recorded["metadata"].get("loopiter_capture", {})
            if identity.get("attempt_id") != attempt_id:
                raise LoopiterError(
                    "conflict",
                    "Observation already exists; inspect the original result instead of replaying.",
                )
            return recorded

        if context.get("id"):
            row = await begin()
        else:
            row = await self._persist(begin)
        finished = False

        async def finish(status: str, value: Any = None) -> None:
            nonlocal finished
            if finished or row is None:
                finished = True
                return
            finished = True
            captured, truncated = _payload(
                None if self.policy["mode"] == "metadata-only" else value, self.policy
            )
            identity = {
                **row["metadata"]["loopiter_capture"],
                "status": status,
                "truncated": truncated
                or row["metadata"]["loopiter_capture"].get("truncated") is True,
                "replay_eligible": False,
            }
            await self._persist(
                lambda: self.loop.complete_execution(
                    row["id"],
                    expected_revision=row["revision"],
                    output=captured,
                    metadata={"loopiter_capture": identity},
                )
            )

        try:
            result = operation()
            if asyncio.iscoroutine(result):
                result = await result
        except Exception:
            try:
                await finish("failed")
            except Exception:
                pass
            raise
        if _is_stream(result):
            return _wrap_stream(result, finish)
        await finish("completed", None if result is None else result)
        return result


def create_observer(loop: Any, **kwargs: Any) -> CaptureClient:
    """Wrap a function and record one execution. Pass bounded for background writes."""
    return CaptureClient(loop, **kwargs)


class _Bounded:
    def __init__(self, owner: CaptureClient, options: dict[str, Any]):
        limit = options.get("queue_limit")
        write_timeout = options.get("write_timeout_ms")
        shutdown_timeout = options.get("shutdown_timeout_ms", write_timeout)
        if type(limit) is not int or limit < 2:
            raise TypeError("queue_limit must be an integer of at least 2.")
        if type(write_timeout) is not int or write_timeout < 1:
            raise TypeError("write_timeout_ms must be a positive integer.")
        if type(shutdown_timeout) is not int or shutdown_timeout < 1:
            raise TypeError("shutdown_timeout_ms must be a positive integer.")
        self.owner = owner
        self.queue_limit = limit
        self.write_timeout_ms = write_timeout
        self.shutdown_timeout_ms = shutdown_timeout
        self.queue: list[Callable[[Callable[[], bool]], Awaitable[None]]] = []
        self.timers: set[asyncio.TimerHandle] = set()
        self.tasks: set[asyncio.Task[None]] = set()
        self.active = 0
        self.reserved = 0
        self.dropped = 0
        self.failed = 0
        self.closed = False
        self.generation = 0
        self.active_deadline = False
        self._open: dict[str, dict[str, Any]] = {}

    def stats(self) -> dict[str, int]:
        return {
            "dropped": self.dropped,
            "failed": self.failed,
            "backlog": self._occupancy(),
        }

    def _occupancy(self) -> int:
        return len(self.queue) + self.active + self.reserved

    def _drop(self) -> None:
        self.dropped += 1
        _note(
            self.owner.on_error,
            RuntimeError(
                "Capture write dropped. The record was not stored and will not be replayed."
            ),
        )

    def pump(self) -> None:
        if self.active > 0 or not self.queue:
            return
        task = self.queue.pop(0)
        token = self.generation
        self.active += 1
        self.active_deadline = False
        deadline_hit = False

        def fire() -> None:
            nonlocal deadline_hit
            if token != self.generation or deadline_hit:
                return
            deadline_hit = True
            self.active_deadline = True
            self.failed += 1
            _note(self.owner.on_error, TimeoutError("Capture write deadline exceeded."))

        handle = asyncio.get_running_loop().call_later(self.write_timeout_ms / 1000, fire)
        self.timers.add(handle)

        async def run() -> None:
            try:
                await task(lambda: deadline_hit)
            except Exception:
                pass
            finally:
                handle.cancel()
                self.timers.discard(handle)
                if token == self.generation:
                    self.active -= 1
                    self.active_deadline = False
                    self.pump()

        job = asyncio.get_running_loop().create_task(run())
        self.tasks.add(job)
        job.add_done_callback(self.tasks.discard)

    def enqueue(self, task: Callable[[Callable[[], bool]], Awaitable[None]]) -> None:
        self.queue.append(task)
        self.pump()

    def abandon(self) -> None:
        for handle in self.timers:
            handle.cancel()
        self.timers.clear()
        inflight = 1 if self.active > 0 and not self.active_deadline else 0
        # A running operation or an unconsumed stream still holds its completion slot.
        count = len(self.queue) + inflight + self.reserved
        self.dropped += count
        for _ in range(count):
            _note(
                self.owner.on_error,
                RuntimeError(
                    "Capture write dropped. The record was not stored and will not be replayed."
                ),
            )
        self.queue.clear()
        self._open.clear()
        self.active = 0
        self.reserved = 0
        self.active_deadline = False
        self.generation += 1

    async def force_flush(self, timeout_ms: int | None = None) -> None:
        timeout = self.shutdown_timeout_ms if timeout_ms is None else timeout_ms
        deadline = time.monotonic() + timeout / 1000
        while self._occupancy() > 0 and time.monotonic() < deadline:  # noqa: ASYNC110
            await asyncio.sleep(0.005)

    async def shutdown(self, timeout_ms: int | None = None) -> None:
        self.closed = True
        await self.force_flush(timeout_ms)
        if self._occupancy() > 0:
            self.abandon()
        self._open.clear()

    def open_record(self, kwargs: dict[str, Any]) -> dict[str, Any] | None:
        """Admit one provider record and its later completion. Does not await the store."""
        fields = dict(kwargs)
        if not fields.get("id"):
            fields["id"] = f"execution_{uuid4()}"
        ticket = self.generation
        if fields["id"] in self._open:
            self._drop()
            return None
        holder: dict[str, Any] = {
            "ticket": ticket,
            "held": False,
            "row": None,
            "late": False,
            "id": fields["id"],
        }
        admitted = (
            not self.closed
            and self.generation == ticket
            and self._occupancy() + 2 <= self.queue_limit
        )
        if not admitted:
            self._drop()
            return None
        holder["held"] = True
        self.reserved += 1
        self._open[fields["id"]] = holder

        async def record(timed_out: Callable[[], bool]) -> None:
            try:
                if self.generation != ticket:
                    return
                recorded = await self.owner.loop.record_execution(**fields)
                if self.generation != ticket:
                    return
                sent = (fields.get("metadata") or {}).get("loopiter_capture")
                if sent is not None and recorded["metadata"].get("loopiter_capture") != sent:
                    raise LoopiterError(
                        "capture_identity", "Sanitizer changed capture identity or status."
                    )
                if timed_out():
                    await self._close_open_late(holder, recorded, ticket)
                    return
                if self.generation != ticket:
                    return
                holder["row"] = recorded
            except Exception as error:
                if not timed_out() and self.generation == ticket:
                    self.failed += 1
                    _note(self.owner.on_error, error)

        self.enqueue(record)
        return {
            "id": fields["id"],
            "revision": 1,
            "metadata": deepcopy(fields.get("metadata") or {}),
            "_bounded": True,
        }

    async def _close_open_late(
        self, holder: dict[str, Any], recorded: dict[str, Any], ticket: int
    ) -> None:
        if self.generation != ticket:
            return
        holder["late"] = True
        identity = {**recorded["metadata"].get("loopiter_capture", {}), "status": "failed"}
        await self.owner.loop.complete_execution(
            recorded["id"],
            expected_revision=recorded["revision"],
            output={"omitted": True},
            metadata={"loopiter_capture": identity},
        )

    def finish_record(self, key: str, complete_kwargs: dict[str, Any]) -> None:
        holder = self._open.pop(key, None)
        if holder is None or not holder["held"]:
            return
        if self.generation != holder["ticket"]:
            holder["held"] = False
            return
        holder["held"] = False
        if self.generation != holder["ticket"]:
            return
        self.reserved -= 1
        if self.reserved < 0:
            raise RuntimeError("Capture reservation went negative.")

        async def complete(timed_out: Callable[[], bool]) -> None:
            row = holder["row"]
            if self.generation != holder["ticket"] or row is None or holder["late"]:
                return
            try:
                await self.owner.loop.complete_execution(
                    row["id"],
                    expected_revision=row["revision"],
                    **complete_kwargs,
                )
            except Exception as error:
                if not timed_out() and self.generation == holder["ticket"]:
                    self.failed += 1
                    _note(self.owner.on_error, error)

        self.enqueue(complete)

    async def observe(
        self,
        name: str,
        operation: Callable[[], Any],
        context: dict[str, Any],
        kind: str,
        input: Any,
    ) -> Any:
        attempt_id = str(uuid4())
        slot: dict[str, Any] = {"row": None, "late": False}
        ticket = self.generation
        held = {"value": False}

        def stale() -> bool:
            return self.generation != ticket

        admitted = not self.closed and not stale() and self._occupancy() + 2 <= self.queue_limit
        held["value"] = admitted
        if not admitted:
            self._drop()
        else:
            self.reserved += 1

        def release() -> None:
            if not held["value"]:
                return
            held["value"] = False
            if stale():
                return
            self.reserved -= 1
            if self.reserved < 0:
                raise RuntimeError("Capture reservation went negative.")

        async def close_late(recorded: dict[str, Any]) -> None:
            if stale():
                return
            slot["late"] = True
            captured, _truncated = _payload(None, self.owner.policy)
            identity = {
                **recorded["metadata"]["loopiter_capture"],
                "status": "failed",
                "truncated": recorded["metadata"]["loopiter_capture"].get("truncated") is True,
                "replay_eligible": False,
            }
            await self.owner.loop.complete_execution(
                recorded["id"],
                expected_revision=recorded["revision"],
                output=captured,
                metadata={"loopiter_capture": identity},
            )

        if admitted:

            async def record(timed_out: Callable[[], bool]) -> None:
                try:
                    if context.get("id") and await self.owner.loop.get_execution(context["id"]):
                        raise LoopiterError(
                            "conflict",
                            "Observation already exists; inspect the original result instead of replaying.",
                        )
                    if stale():
                        return
                    fields = _record_fields(
                        name, attempt_id, context, kind, input, self.owner.policy, "pending"
                    )
                    recorded = await self.owner.loop.record_execution(**fields)
                    if stale():
                        return
                    if (
                        recorded["metadata"].get("loopiter_capture", {}).get("attempt_id")
                        != attempt_id
                    ):
                        raise LoopiterError(
                            "conflict",
                            "Observation already exists; inspect the original result instead of replaying.",
                        )
                    if timed_out():
                        await close_late(recorded)
                        return
                    if stale():
                        return
                    slot["row"] = recorded
                except Exception as error:
                    if not timed_out() and not stale():
                        self.failed += 1
                        _note(self.owner.on_error, error)

            self.enqueue(record)

        def finish(status: str, value: Any = None) -> None:
            if not admitted or not held["value"]:
                return
            if stale():
                held["value"] = False
                return
            release()
            if stale():
                return

            async def complete(timed_out: Callable[[], bool]) -> None:
                row = slot["row"]
                if stale() or row is None or slot["late"]:
                    return
                try:
                    captured, truncated = _payload(
                        None if self.owner.policy["mode"] == "metadata-only" else value,
                        self.owner.policy,
                    )
                    identity = {
                        **row["metadata"]["loopiter_capture"],
                        "status": status,
                        "truncated": truncated
                        or row["metadata"]["loopiter_capture"].get("truncated") is True,
                        "replay_eligible": False,
                    }
                    await self.owner.loop.complete_execution(
                        row["id"],
                        expected_revision=row["revision"],
                        output=captured,
                        metadata={"loopiter_capture": identity},
                    )
                    if stale() or timed_out():
                        return
                except Exception as error:
                    if not timed_out() and not stale():
                        self.failed += 1
                        _note(self.owner.on_error, error)

            self.enqueue(complete)

        try:
            result = operation()
            if asyncio.iscoroutine(result):
                result = await result
        except Exception:
            finish("failed")
            raise
        if _is_stream(result):
            return _wrap_stream(result, finish)
        finish("completed", None if result is None else result)
        return result


def _check_name(name: str) -> None:
    if type(name) is not str or not name.strip() or len(name) > 200:
        raise TypeError("Observation name must be 1–200 characters.")


def _is_stream(value: Any) -> bool:
    return hasattr(value, "__aiter__") and not asyncio.iscoroutine(value)


def _wrap_stream(source: Any, finish: Callable[..., Any]) -> Any:
    async def wrapped():
        ended = False
        failed_stream = False
        chunks = 0
        try:
            async for chunk in source:
                chunks += 1
                yield chunk
            ended = True
        except Exception:
            failed_stream = True
            raise
        finally:
            status = "failed" if failed_stream else "completed" if ended else "cancelled"
            outcome = finish(status, {"chunks": chunks})
            if asyncio.iscoroutine(outcome):
                await outcome

    return wrapped()


def _record_fields(
    name: str,
    attempt_id: str,
    context: dict[str, Any],
    kind: str,
    input: Any,
    policy: dict[str, Any],
    status: str,
) -> dict[str, Any]:
    captured, truncated = _payload(input, policy)
    metadata = {
        **{key: _json_clone(value) for key, value in context.items()},
        "observation": name,
        "observe_only": True,
        "loopiter_capture": {
            "attempt_id": attempt_id,
            "status": status,
            "mode": policy["mode"],
            "truncated": truncated,
            "replay_eligible": False,
        },
    }
    fields: dict[str, Any] = {
        "id": context.get("id") or f"observe_{attempt_id}",
        "kind": kind,
        "input": captured,
        "artifacts": {"prompt": context["release_id"]} if context.get("release_id") else {},
        "metadata": metadata,
    }
    for key in ("episode_id", "entity_id", "parent_execution_id"):
        if key in context:
            fields[key] = context[key]
    return fields
