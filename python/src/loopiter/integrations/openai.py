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
from copy import deepcopy
from typing import Any
from uuid import uuid4

from .._validation import LoopiterError
from .context import guidance_messages, replace_guidance
from .observe import CaptureClient
from .privacy import capture_payload, json_size


def _json(value):
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


def _policy_limit(policy):
    if not policy:
        return None
    return policy.get("maximumBytes", policy.get("maximum_bytes", 65536))


def _apply_policy(value, policy):
    if not policy:
        return value, False
    captured = capture_payload(value, policy)
    return captured["value"], captured["truncated"]


class _Capture:
    def __init__(self, owner, execution):
        self.owner, self.execution = owner, execution
        self.events, self.size, self.finished, self.truncated = [], 0, False, False
        self.lock = asyncio.Lock()
        self._noted = False
        identity = execution["metadata"]["loopiter_capture"]
        if identity.get("truncated") is True:
            self.truncated = True

    def append(self, event):
        policy = getattr(self.owner.capture, "policy", None)
        if policy and (policy.get("mode") == "metadata-only" or self.truncated):
            return
        data = _json(event)
        self.size += json_size(data)
        limit = _policy_limit(policy)
        over_policy = bool(policy and limit is not None and self.size > limit)
        over_hard = self.size > self.owner.maximum_output_bytes
        if self.owner.strict_output_bytes:
            if over_hard:
                raise ValueError("Captured stream exceeded maximum_output_bytes.")
            if over_policy:
                self.truncated = True
                self.events.clear()
                return
        elif over_policy or over_hard:
            self._mark_overflow("Captured stream exceeded maximum_output_bytes.")
            return
        self.events.append(data)

    def _mark_overflow(self, message: str) -> None:
        self.truncated = True
        self.events.clear()
        if self._noted:
            return
        self._noted = True
        callback = getattr(self.owner.capture, "on_error", None)
        if callback is None:
            return
        try:
            callback(ValueError(message))
        except Exception:
            return

    async def finish(self, status, output=None):
        async with self.lock:
            if self.finished:
                return
            policy = getattr(self.owner.capture, "policy", None)
            if policy and policy.get("mode") == "metadata-only":
                value = None
            else:
                value = {"events": self.events} if output is None else _json(output)
            if self.owner.strict_output_bytes and (
                value is not None
                and (not policy or policy.get("mode") == "full")
                and json_size(value) > self.owner.maximum_output_bytes
            ):
                if status in ("completed", "incomplete"):
                    raise ValueError("Captured response exceeded maximum_output_bytes.")
                value = None
            elif policy and policy.get("mode") != "metadata-only":
                captured_value, truncated = _apply_policy(value, policy)
                self.truncated = self.truncated or truncated
                value = {"omitted": True, "truncated": True} if self.truncated else captured_value
                if value is not None and json_size(value) > self.owner.maximum_output_bytes:
                    if self.owner.strict_output_bytes and status in ("completed", "incomplete"):
                        raise ValueError("Captured response exceeded maximum_output_bytes.")
                    self._mark_overflow("Captured response exceeded maximum_output_bytes.")
                    value = {"omitted": True, "truncated": True}
                elif self.truncated and not self.owner.strict_output_bytes:
                    self._mark_overflow("Captured response exceeded maximum_output_bytes.")
            identity = dict(self.execution["metadata"]["loopiter_capture"])
            if policy:
                identity["truncated"] = self.truncated or identity.get("truncated") is True
                identity["replay_eligible"] = False
            saved = await self.owner.capture.complete_execution(
                self.execution["id"],
                expected_revision=self.execution["revision"],
                output=value,
                metadata={"loopiter_capture": {**identity, "status": status}},
            )
            if self.execution.get("_bounded"):
                self.finished = True
                return
            saved_identity = (saved or {}).get("metadata", {}).get("loopiter_capture") or {}
            if (
                saved_identity.get("attempt_id") != identity.get("attempt_id")
                or saved_identity.get("status") != status
            ):
                raise LoopiterError(
                    "capture_identity", "Sanitizer changed capture identity or status."
                )
            self.finished = True
            if self.owner.on_execution:
                await _resolve(self.owner.on_execution(deepcopy(saved)))


class _CapturedStream:
    def __init__(self, source, capture, api, expected_choices):
        self.source, self.capture, self.api = source, capture, api
        self.expected_choices = expected_choices
        self.choices, self.status = set(), "incomplete"
        self.iterator = source.__aiter__()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            event = await self.iterator.__anext__()
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
            await self.capture.finish(self.status)
            raise
        except BaseException as error:
            try:
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
    def __init__(
        self,
        client,
        *,
        loop,
        context,
        on_execution,
        maximum_output_bytes,
        capture,
        strict_output_bytes,
    ):
        self.base = client.base if isinstance(client, _Client) else client
        self.capture = capture
        self.loop, self.context, self.on_execution = loop, context, on_execution
        self.maximum_output_bytes = maximum_output_bytes
        self.strict_output_bytes = strict_output_bytes
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
            context = _json(await _resolve(self.context(deepcopy(request))))
            if not isinstance(context.get("artifacts"), dict):
                raise TypeError("Capture context requires artifact versions.")
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
            policy = getattr(self.capture, "policy", None)
            stored_input, input_truncated = _apply_policy(_json(input_), policy)
            caller_metadata = context.get("metadata") or {}
            meta_truncated = False
            if policy and policy.get("mode") == "metadata-only":
                stored_metadata = {}
            elif policy:
                stored_metadata, meta_truncated = _apply_policy(caller_metadata, policy)
                if not isinstance(stored_metadata, dict):
                    stored_metadata = {}
            else:
                stored_metadata = dict(caller_metadata)
            identity = {
                "attempt_id": attempt_id,
                "integration": request["integration"],
                "status": "pending",
            }
            if policy:
                identity["mode"] = policy["mode"]
                identity["truncated"] = bool(input_truncated or meta_truncated)
                identity["replay_eligible"] = False
            execution = await self.capture.record_execution(
                **{
                    key: context[key]
                    for key in ("id", "episode_id", "entity_id", "parent_execution_id")
                    if key in context
                },
                kind="inference",
                input=stored_input,
                artifacts={**context["artifacts"], "model": request["model"]},
                metadata={**stored_metadata, "loopiter_capture": identity},
            )
            if execution is None:
                return await create(**params)
            if execution["metadata"].get("loopiter_capture") != identity:
                raise LoopiterError(
                    "capture_identity", "Sanitizer changed capture identity or status."
                )
            capture = _Capture(self, execution)
            try:
                if self.on_execution:
                    await _resolve(self.on_execution(deepcopy(execution)))
                response = await create(**params)
                if params.get("stream"):
                    return _CapturedStream(response, capture, api, params.get("n", 1))
                await capture.finish(_status(_json(response), api), response)
                return response
            except BaseException as error:
                await capture.finish(
                    "cancelled" if isinstance(error, asyncio.CancelledError) else "failed"
                )
                raise

        return captured


def with_loopiter(
    client, *, loop, context, on_execution=None, maximum_output_bytes=65536, capture=None
):
    """Return an isolated async client facade. Feedback remains an explicit record_signal call.

    Context returns artifact versions and optional id/episode_id/entity_id/guidance.
    Use a fresh execution id per provider call. Streams must be drained or closed;
    use ``async with stream`` when breaking out early. Capture failures propagate.
    """
    if type(maximum_output_bytes) is not int or maximum_output_bytes < 1:
        raise ValueError("maximum_output_bytes must be a positive integer.")
    if capture is None:
        policy: dict[str, Any] = {"mode": "full"}
        if maximum_output_bytes >= 128:
            policy["maximumBytes"] = min(maximum_output_bytes, 1_048_576)
        writer = CaptureClient(loop, failure_mode="closed", capture=policy)
    else:
        writer = capture
    return _Client(
        client,
        loop=writer.loop,
        context=context,
        on_execution=on_execution,
        maximum_output_bytes=maximum_output_bytes,
        capture=writer,
        strict_output_bytes=capture is None,
    )
