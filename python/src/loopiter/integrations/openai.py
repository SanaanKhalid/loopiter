"""Capture AsyncOpenAI chat.completions.create and responses.create.

Isolated resource facades adapt Supermemory's Python middleware pattern (MIT).
Copyright (c) 2025 Supermemory Inc. See THIRD_PARTY_NOTICES.md.
Execution capture and stream lifecycle are Loopiter implementations.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any, TypeVar, cast
from uuid import uuid4

from .._validation import LoopiterError
from .context import guidance_messages, replace_guidance
from .privacy import CapturePolicy, JsonValue, capture_payload, checked_policy, redact_capture

_LOG = logging.getLogger("loopiter.integrations.openai")
ClientT = TypeVar("ClientT")


def _log_capture(step: str, error: BaseException) -> None:
    _LOG.warning("capture %s failed: %s", step, type(error).__name__)


def _json(value: Any) -> Any:
    def convert(item):
        if hasattr(item, "model_dump"):
            return item.model_dump(mode="json")
        if isinstance(item, bytes):
            return {"encoding": "base64", "data": base64.b64encode(item).decode("ascii")}
        raise TypeError("Captured provider payloads must be JSON serializable.")

    return json.loads(json.dumps(value, default=convert, allow_nan=False, ensure_ascii=False))


async def _resolve(value):
    return await value if inspect.isawaitable(value) else value


def _status(payload, api):
    if api == "responses":
        status = payload.get("status")
        return status if status in ("completed", "failed") else "incomplete"
    choices = payload.get("choices", [])
    good = ("stop", "tool_calls", "function_call")
    return (
        "completed"
        if choices and all(choice.get("finish_reason") in good for choice in choices)
        else "incomplete"
    )


class _Capture:
    def __init__(self, owner: _Client, execution: dict[str, Any]) -> None:
        self.owner, self.execution = owner, execution
        self.events: list[Any] = []
        self.size, self.finished, self.truncated = 0, False, False
        self.lock = asyncio.Lock()

    def append(self, event: Any) -> None:
        if self.owner.policy["mode"] == "metadata-only" or self.truncated:
            return
        try:
            data = _json(event)
            if self.owner.policy["mode"] == "redacted":
                data = redact_capture(data)
            self.size += len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        except Exception as error:
            _log_capture("sanitize", error)
            self.truncated = True
            self.events.clear()
            return
        if self.size > self.owner.maximum_output_bytes:
            self.truncated = True
            self.events.clear()
            return
        self.events.append(data)

    async def finish(self, status, output=None):
        async with self.lock:
            if self.finished:
                return
            if self.owner.policy["mode"] == "metadata-only":
                value: Any = {"omitted": True}
                truncated = False
            elif self.truncated:
                value = {"omitted": True, "truncated": True}
                truncated = True
            else:
                try:
                    value = {"events": self.events} if output is None else _json(output)
                    packed = capture_payload(cast(JsonValue, value), self.owner.policy)
                    truncated = bool(packed["truncated"])
                    value = {"omitted": True, "truncated": True} if truncated else packed["value"]
                    if (
                        value is not None
                        and len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
                        > self.owner.maximum_output_bytes
                    ):
                        truncated = True
                        value = {"omitted": True, "truncated": True}
                except Exception as error:
                    _log_capture("sanitize", error)
                    return
            identity = self.execution["metadata"]["loopiter_capture"]
            updated = {
                **identity,
                "status": status,
                "truncated": bool(identity.get("truncated") or truncated),
                "replay_eligible": False,
            }
            try:
                saved = await self.owner.loop.complete_execution(
                    self.execution["id"],
                    expected_revision=self.execution["revision"],
                    output=value,
                    metadata={"loopiter_capture": updated},
                )
            except Exception as error:
                _log_capture("complete_execution", error)
                return
            if saved["metadata"].get("loopiter_capture") != updated:
                _log_capture(
                    "complete_execution",
                    LoopiterError(
                        "capture_identity", "Sanitizer changed capture identity or status."
                    ),
                )
                return
            self.finished = True
            if self.owner.on_execution:
                try:
                    await _resolve(self.owner.on_execution(deepcopy(saved)))
                except Exception as error:
                    _log_capture("on_execution", error)


class _CapturedStream:
    def __init__(
        self, source: Any, capture: _Capture | None, api: str, expected_choices: int
    ) -> None:
        self.source, self.capture, self.api = source, capture, api
        self.expected_choices = expected_choices
        self.choices, self.status = set(), "incomplete"
        self.iterator = source.__aiter__()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            event = await self.iterator.__anext__()
            if self.capture is not None:
                self.capture.append(event)
            data = _json(event)
            if self.api == "responses":
                if data.get("type") in (
                    "response.completed",
                    "response.failed",
                    "response.incomplete",
                ):
                    self.status = _status(data.get("response", {}), self.api)
            else:
                for choice in data.get("choices", []):
                    if choice.get("finish_reason") is not None:
                        if choice["finish_reason"] not in ("stop", "tool_calls", "function_call"):
                            self.status = "incomplete"
                            self.choices.add("incomplete")
                        self.choices.add(choice["index"])
                if "incomplete" not in self.choices and len(self.choices) >= self.expected_choices:
                    self.status = "completed"
            return event
        except StopAsyncIteration:
            if self.capture is not None:
                await self.capture.finish(self.status)
            raise
        except BaseException as error:
            try:
                if self.capture is not None:
                    await self.capture.finish(
                        "cancelled" if isinstance(error, asyncio.CancelledError) else "failed"
                    )
            finally:
                await self.source.close()
            raise

    async def close(self):
        try:
            await self.source.close()
        finally:
            if self.capture is not None:
                await self.capture.finish("cancelled")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        await self.close()


class _Facade:
    """Delegate unrelated attributes without mutating a shared provider client."""

    def __init__(self, resource, **overrides):
        self._resource, self._overrides = resource, overrides

    def __getattr__(self, name):
        if name in ("with_raw_response", "with_streaming_response", "stream", "parse"):
            raise TypeError(
                "Use create(stream=True) for captured streams; raw/parse helpers are unsupported."
            )
        if name in self._overrides:
            return self._overrides[name]
        return getattr(self._resource, name)


class _Client(_Facade):
    def __init__(self, client, *, loop, context, on_execution, maximum_output_bytes, policy):
        self.base = client.base if isinstance(client, _Client) else client
        self.loop, self.context, self.on_execution = loop, context, on_execution
        self.maximum_output_bytes = maximum_output_bytes
        self.policy = policy
        super().__init__(
            self.base,
            chat=_Facade(
                self.base.chat,
                completions=_Facade(
                    self.base.chat.completions,
                    create=self._create(self.base.chat.completions.create, "chat.completions"),
                ),
            ),
            responses=_Facade(
                self.base.responses, create=self._create(self.base.responses.create, "responses")
            ),
        )

    def _create(self, create, api):
        async def captured(**params):
            params = deepcopy(params)
            if not inspect.iscoroutinefunction(inspect.unwrap(create)):
                raise TypeError("with_loopiter requires an async OpenAI client.")
            # Transport credentials and headers are never captured as model input.
            input_ = {
                key: value
                for key, value in params.items()
                if key not in ("extra_headers", "extra_query", "timeout")
            }
            request = {
                "integration": f"openai.{api}",
                "model": str(params.get("model", "")),
                "input": _json(input_),
            }
            try:
                context = _json(await _resolve(self.context(deepcopy(request))))
            except Exception as error:
                _log_capture("context", error)
                context = {"artifacts": {}}
            if not isinstance(context.get("artifacts"), dict):
                _log_capture("context", TypeError("Capture context requires artifact versions."))
                context = {"artifacts": {}}
            guidance = context.get("guidance")
            if guidance is not None:
                if not isinstance(guidance, str) or not context["artifacts"].get("prompt"):
                    raise TypeError("Released guidance requires a string and artifacts.prompt.")
                params = {
                    **params,
                    **(
                        {
                            "instructions": replace_guidance(
                                params.get("instructions") or "", guidance
                            )
                        }
                        if api == "responses"
                        else {"messages": guidance_messages(params["messages"], guidance)}
                    ),
                }
                input_.update(
                    {key: params[key] for key in ("instructions", "messages") if key in params}
                )
            attempt_id = str(uuid4())
            try:
                stored_input = capture_payload(_json(input_), self.policy)
            except Exception as error:
                _log_capture("sanitize", error)
                stored_input = None
            capture: _Capture | None = None
            execution: dict[str, Any] | None = None
            if stored_input is not None:
                identity = {
                    "attempt_id": attempt_id,
                    "integration": request["integration"],
                    "status": "pending",
                    "mode": self.policy["mode"],
                    "truncated": stored_input["truncated"],
                    "replay_eligible": False,
                }
                extra: Any = {}
                if self.policy["mode"] != "metadata-only":
                    extra = context.get("metadata") or {}
                    if self.policy["mode"] == "redacted":
                        try:
                            extra = redact_capture(extra)
                        except Exception as error:
                            _log_capture("sanitize", error)
                            extra = {}
                    if not isinstance(extra, dict):
                        extra = {}
                try:
                    execution = await self.loop.record_execution(
                        **{
                            key: context[key]
                            for key in ("id", "episode_id", "entity_id", "parent_execution_id")
                            if key in context
                        },
                        kind="inference",
                        input=stored_input["value"],
                        artifacts={**context["artifacts"], "model": request["model"]},
                        metadata={**extra, "loopiter_capture": identity},
                    )
                    if execution["metadata"].get("loopiter_capture") != identity:
                        raise LoopiterError(
                            "capture_identity", "Sanitizer changed capture identity or status."
                        )
                    capture = _Capture(self, execution)
                except Exception as error:
                    _log_capture("record_execution", error)
                    capture = None
            if capture is not None and execution is not None and self.on_execution:
                try:
                    await _resolve(self.on_execution(deepcopy(execution)))
                except Exception as error:
                    _log_capture("on_execution", error)
            try:
                response = await create(**params)
                if params.get("stream"):
                    return _CapturedStream(response, capture, api, params.get("n", 1))
                if capture is not None:
                    try:
                        status = _status(_json(response), api)
                    except Exception as error:
                        _log_capture("sanitize", error)
                        status = "incomplete"
                    await capture.finish(status, response)
                return response
            except BaseException as error:
                if capture is not None:
                    await capture.finish(
                        "cancelled" if isinstance(error, asyncio.CancelledError) else "failed"
                    )
                raise

        return captured


def with_loopiter(
    client: ClientT,
    *,
    loop: Any,
    context: Callable[[dict[str, Any]], dict[str, Any] | Awaitable[dict[str, Any]]],
    on_execution: Callable[[dict[str, Any]], Any] | None = None,
    maximum_output_bytes: int = 65536,
    capture: CapturePolicy | None = None,
) -> ClientT:
    """Return an isolated async client facade. Feedback remains an explicit record_signal call.

    Context returns artifact versions and optional id/episode_id/entity_id/guidance.
    Use a fresh execution id per provider call. Streams must be drained or closed;
    use ``async with stream`` when breaking out early. Capture, store, and context
    failures are logged and do not replace the provider result.
    ``capture`` defaults to metadata-only. Pass ``full`` or ``redacted`` to retain bodies.
    Metadata-only input and output are ``{"omitted": true}``.
    """
    if type(maximum_output_bytes) is not int or maximum_output_bytes < 1:
        raise ValueError("maximum_output_bytes must be a positive integer.")
    return _Client(
        client,
        loop=loop,
        context=context,
        on_execution=on_execution,
        maximum_output_bytes=maximum_output_bytes,
        policy=checked_policy(capture),
    )
