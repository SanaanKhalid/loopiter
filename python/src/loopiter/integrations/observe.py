"""Async application, tool, and retrieval observation. Does not install a tracer."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal, TypeVar, cast
from uuid import uuid4

from .capture import capture_json
from .privacy import (
    CapturePolicy,
    JsonValue,
    capture_payload,
    checked_policy,
    redact_capture,
)

T = TypeVar("T")


class ApplicationContext(dict[str, Any]):
    """Set from authenticated application state, never directly from an end-user form."""


class ObservationContext(dict[str, Any]):
    """Lineage for one observation. id is an opaque durable claim, not a result cache."""


class Observer:
    def __init__(
        self,
        loop: Any,
        policy: CapturePolicy,
        failure_mode: str,
        on_error: Callable[[BaseException], Any] | None,
    ) -> None:
        self._loop = loop
        self._policy = policy
        self._failure_mode = failure_mode
        self._on_error = on_error

    async def observe(
        self,
        name: object,
        operation: Callable[[], T | Awaitable[T]],
        *,
        context: ObservationContext | None = None,
        kind: str | None = None,
        input: JsonValue | None = None,
    ) -> T:
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise TypeError("Observation name must be 1–200 characters.")
        raw_context = cast(dict[str, Any], capture_json(dict(context or {})))
        attempt_id = str(uuid4())
        row: dict[str, Any] | None = None

        async def persist(action: Callable[[], Awaitable[Any]]) -> Any:
            try:
                return await action()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if self._on_error is not None:
                    try:
                        callback = self._on_error(error)
                        if inspect.isawaitable(callback):
                            await callback
                    except Exception:
                        pass
                if self._failure_mode == "closed":
                    raise
                return None

        async def begin() -> dict[str, Any]:
            # A caller-supplied durable ID requires reliable claiming even in fail-open mode.
            if raw_context.get("id") and await self._loop.get_execution(raw_context["id"]):
                raise RuntimeError(
                    "Observation already exists; inspect the original result instead of replaying."
                )
            captured = capture_payload(None if input is None else input, self._policy)
            stored_context = _stored_context(raw_context, self._policy["mode"])
            fields: dict[str, Any] = {
                "id": (
                    raw_context["id"]
                    if raw_context.get("id") is not None
                    else f"observe_{attempt_id}"
                ),
                "kind": "workflow" if kind is None else kind,
                "input": captured["value"],
                "artifacts": (
                    {"prompt": raw_context["release_id"]} if raw_context.get("release_id") else {}
                ),
                "metadata": {
                    **stored_context,
                    "observation": name,
                    "observe_only": True,
                    "loopiter_capture": {
                        "attempt_id": attempt_id,
                        "status": "pending",
                        "mode": self._policy["mode"],
                        "truncated": captured["truncated"],
                        "replay_eligible": False,
                    },
                },
            }
            for key in ("episode_id", "entity_id", "parent_execution_id"):
                if raw_context.get(key):
                    fields[key] = raw_context[key]
            recorded = await self._loop.record_execution(**fields)
            return cast(dict[str, Any], recorded)

        # Reusing an execution ID cannot cause an already recorded call to run again.
        row = await begin() if raw_context.get("id") else await persist(begin)
        if isinstance(row, dict):
            metadata = cast(object, row.get("metadata"))
            saved = (
                cast(dict[str, Any], metadata).get("loopiter_capture")
                if isinstance(metadata, dict)
                else None
            )
            saved_identity = cast(dict[str, Any], saved) if isinstance(saved, dict) else {}
            if saved_identity.get("attempt_id") != attempt_id:
                raise RuntimeError(
                    "Observation already exists; inspect the original application result "
                    "instead of replaying."
                )
        finished = False

        async def finish(status: str, value: object = None) -> None:
            nonlocal finished
            if finished:
                return
            finished = True
            if not isinstance(row, dict):
                return

            async def action() -> None:
                assert isinstance(row, dict)
                captured = capture_payload(
                    None if self._policy["mode"] == "metadata-only" else capture_json(value),
                    self._policy,
                )
                previous = cast(dict[str, Any], row["metadata"]["loopiter_capture"])
                await self._loop.complete_execution(
                    row["id"],
                    expected_revision=row["revision"],
                    output=captured["value"],
                    metadata={
                        "loopiter_capture": {
                            **previous,
                            "status": status,
                            "truncated": captured["truncated"] or previous.get("truncated") is True,
                            "replay_eligible": False,
                        }
                    },
                )

            await persist(action)

        try:
            raw_result = operation()
            if inspect.isawaitable(raw_result):
                outcome = cast(T, await raw_result)
            else:
                outcome = cast(T, raw_result)
        except asyncio.CancelledError:
            try:
                await finish("cancelled")
            except Exception:
                pass
            raise
        except Exception:
            try:
                await finish("failed")
            except Exception:
                pass
            raise
        candidate = cast(object, outcome)
        if candidate is not None and callable(getattr(candidate, "__aiter__", None)):
            return cast(T, _ObservedStream(cast(AsyncIterator[object], candidate), finish))
        await finish("completed", None if outcome is None else outcome)
        return outcome


class _ObservedStream:
    """Lazy stream. Chunk bodies are never stored; only the count is.

    JavaScript ``for await`` calls ``iterator.return()`` on ``break``. Python's
    ``async for`` does not, so breaking out of the loop leaves the execution
    pending until ``aclose()`` or the async context manager exits.
    """

    def __init__(
        self, source: AsyncIterator[object], finish: Callable[[str, object], Awaitable[None]]
    ) -> None:
        self._source = source
        self._finish = finish
        self._iterator: AsyncIterator[object] | None = None
        self._ended = False
        self._failed = False
        self._chunks = 0
        self._closed = False

    def __aiter__(self) -> _ObservedStream:
        if self._iterator is None:
            self._iterator = self._source.__aiter__()
        return self

    async def __anext__(self) -> object:
        if self._iterator is None:
            self._iterator = self._source.__aiter__()
        try:
            chunk = await self._iterator.__anext__()
        except StopAsyncIteration:
            self._ended = True
            await self.aclose()
            raise
        except asyncio.CancelledError:
            await self.aclose()
            raise
        except Exception:
            self._failed = True
            try:
                await self.aclose()
            except Exception:
                pass
            raise
        self._chunks += 1
        return chunk

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        iterator = self._iterator if self._iterator is not None else self._source
        closer = getattr(iterator, "aclose", None)
        if callable(closer):
            closed = closer()
            if inspect.isawaitable(closed):
                await closed
        payload = {"chunks": self._chunks}
        if self._failed:
            try:
                await self._finish("failed", payload)
            except Exception:
                pass
            return
        await self._finish("completed" if self._ended else "cancelled", payload)

    async def __aenter__(self) -> _ObservedStream:
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None, *_args: object) -> bool:
        if (
            exc_type is not None
            and exc_type not in (GeneratorExit, StopAsyncIteration)
            and not issubclass(exc_type, asyncio.CancelledError)
        ):
            self._failed = True
        await self.aclose()
        return False


_CONTEXT_KEYS = (
    "id",
    "episode_id",
    "entity_id",
    "parent_execution_id",
    "release_id",
    "trace_id",
    "span_id",
)


def _stored_context(raw: dict[str, Any], mode: str) -> dict[str, Any]:
    """metadata-only keeps lineage identifiers and drops other context fields."""
    if mode != "metadata-only":
        return raw
    return {key: raw[key] for key in _CONTEXT_KEYS if key in raw}


def create_observer(
    *,
    loop: Any,
    capture: CapturePolicy | None = None,
    failure_mode: Literal["open", "closed"] = "open",
    on_error: Callable[[BaseException], Any] | None = None,
) -> Observer:
    """Telemetry failure never causes the operation to be retried. Defaults to open.

    Supplying context id always claims that execution before the operation runs.
    Async iterables stay lazy. A stream that is never consumed stays pending.
    """
    mode = str(failure_mode)
    if mode not in ("open", "closed"):
        raise TypeError("Invalid failure_mode.")
    return Observer(loop, checked_policy(capture), mode, on_error)


__all__ = [
    "ApplicationContext",
    "ObservationContext",
    "Observer",
    "capture_payload",
    "create_observer",
    "redact_capture",
]
