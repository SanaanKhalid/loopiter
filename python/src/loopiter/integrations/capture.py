"""Shared execution capture for provider calls and custom integrations.

Provider values are normalized before the SDK sanitizer and byte limits.
Existing OpenAI wrappers keep their own full-capture path; this session is the
portable contract those Node wrappers share.
"""

from __future__ import annotations

import base64
import inspect
import math
from collections.abc import Awaitable, Mapping
from typing import Any, Literal, TypeVar, cast
from uuid import uuid4

from .._validation import LoopiterError
from .privacy import CapturePolicy, JsonValue, capture_payload, json_utf8_size, redact_capture

CaptureStatus = Literal["completed", "incomplete", "cancelled", "failed"]
_MISSING = object()
T = TypeVar("T")


class ExecutionContext(dict[str, Any]):
    """Artifact versions plus optional lineage. A new id for each provider call."""


class CaptureRequest(dict[str, Any]):
    """integration, model, and the detached provider input."""


def capture_json(value: object) -> JsonValue:
    return cast(JsonValue, _provider_value(value, normalize=True, ancestors=set()))


def capture_snapshot(value: object) -> object:
    """Detach supported request payloads before awaiting application callbacks."""
    return _provider_value(value, normalize=False, ancestors=set())


def _provider_value(value: object, *, normalize: bool, ancestors: set[int]) -> object:
    if value is None or isinstance(value, str) or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
        return value
    if isinstance(value, memoryview):
        raw = value.tobytes()
    elif isinstance(value, bytearray):
        raw = bytes(value)
    elif isinstance(value, bytes):
        raw = value
    else:
        raw = None
    if raw is not None:
        if normalize:
            raw = _scrub_binary_text(raw)
            return {"encoding": "base64", "data": base64.b64encode(raw).decode("ascii")}
        return raw
    if isinstance(value, list):
        items = cast(list[object], value)
        return _walk_sequence(items, normalize=normalize, ancestors=ancestors, as_tuple=False)
    if isinstance(value, tuple):
        items = cast(tuple[object, ...], value)
        return _walk_sequence(items, normalize=normalize, ancestors=ancestors, as_tuple=True)
    if not isinstance(value, dict):
        raise TypeError("Unsupported provider payload object; supply plain JSON.")
    mapping = cast(dict[object, object], value)
    if type(mapping) is not dict:
        raise TypeError("Unsupported provider payload object; supply plain JSON.")
    if id(mapping) in ancestors:
        raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
    ancestors.add(id(mapping))
    try:
        result: dict[str, object] = {}
        for key, entry in mapping.items():
            if not isinstance(key, str):
                raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
            result[key] = _provider_value(entry, normalize=normalize, ancestors=ancestors)
        return result
    finally:
        ancestors.discard(id(mapping))


def _scrub_binary_text(raw: bytes) -> bytes:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw
    cleaned = redact_capture(text)
    if not isinstance(cleaned, str) or cleaned == text:
        return raw
    return cleaned.encode("utf-8")


def _walk_sequence(
    items: list[object] | tuple[object, ...],
    *,
    normalize: bool,
    ancestors: set[int],
    as_tuple: bool,
) -> list[object] | tuple[object, ...]:
    if id(items) in ancestors:
        raise TypeError("Captured provider payloads must be finite, acyclic JSON values.")
    ancestors.add(id(items))
    try:
        walked = [_provider_value(item, normalize=normalize, ancestors=ancestors) for item in items]
    finally:
        ancestors.discard(id(items))
    if as_tuple and not normalize:
        return tuple(walked)
    return walked


def finish_status(reason: object) -> CaptureStatus:
    if isinstance(reason, Mapping):
        normalized: object = cast(Mapping[str, object], reason).get("unified")
    else:
        normalized = reason
    if normalized in ("stop", "tool_calls", "tool-calls", "function_call"):
        return "completed"
    if normalized == "error":
        return "failed"
    return "incomplete"


async def _resolve(value: T | Awaitable[T]) -> T:
    if inspect.isawaitable(value):
        return await value
    return value


async def resolve_context(options: Mapping[str, Any], request: Mapping[str, Any]) -> dict[str, Any]:
    """Detach mutable application configuration before any external operation."""
    context_fn = options["context"]
    produced = await _resolve(context_fn(capture_json(dict(request))))
    context_value = capture_json(produced)
    if not isinstance(context_value, dict):
        raise TypeError("Capture context requires artifact versions.")
    context = cast(dict[str, Any], context_value)
    artifacts_raw = context.get("artifacts")
    if not isinstance(artifacts_raw, dict):
        raise TypeError("Capture context requires artifact versions.")
    artifacts = cast(dict[str, Any], artifacts_raw)
    if "guidance" in context and (
        not isinstance(context.get("guidance"), str) or not artifacts.get("prompt")
    ):
        raise TypeError("Released guidance requires a string and artifacts.prompt.")
    return context


class _OverrideProxy:
    def __init__(self, source: object, overrides: Mapping[str, Any]) -> None:
        object.__setattr__(self, "_source", source)
        object.__setattr__(self, "_overrides", dict(overrides))

    def __getattr__(self, name: str) -> Any:
        overrides: Mapping[str, Any] = object.__getattribute__(self, "_overrides")
        if name in overrides:
            return overrides[name]
        return getattr(object.__getattribute__(self, "_source"), name)


def clone_with_overrides(source: T, overrides: object) -> T:
    """Delegate to source while exposing overrides.

    Node copies property descriptors and keeps the original prototype, so
    ``instanceof`` still holds. Python returns a proxy: attribute access matches,
    and ``isinstance`` does not. Special methods are looked up on the proxy type.
    """
    if not isinstance(overrides, Mapping):
        raise TypeError("Overrides must be a mapping.")
    return cast(T, _OverrideProxy(source, cast(Mapping[str, Any], overrides)))


class CaptureSession:
    def __init__(
        self,
        options: Mapping[str, Any],
        execution: dict[str, Any],
        maximum: int,
    ) -> None:
        self._options = options
        self.execution = execution
        self._maximum = maximum
        self._finalization: Awaitable[None] | None = None
        self._bytes = 0
        self._truncated = False
        self._events: list[JsonValue] = []

    @classmethod
    async def begin(
        cls,
        options: Mapping[str, Any],
        context: Mapping[str, Any],
        request: Mapping[str, Any],
    ) -> CaptureSession:
        """Start a captured execution. Persistence and capture failures raise.

        The OpenAI wrapper, and the Node Vercel AI SDK wrapper, fail open
        around this call: they log those failures and still return the provider
        result. Provider errors still propagate.
        """
        maximum = options.get("maximum_output_bytes", 65536)
        if (
            isinstance(maximum, bool)
            or type(maximum) is not int
            or maximum < 1
            or maximum > 2**53 - 1
        ):
            raise TypeError("maximum_output_bytes must be a positive integer.")
        policy_raw = options.get("capture")
        policy: CapturePolicy | None
        if policy_raw is None:
            policy = None
        elif isinstance(policy_raw, Mapping):
            policy = cast(CapturePolicy, policy_raw)
        else:
            raise TypeError("Invalid capture mode.")
        attempt_id = str(uuid4())
        captured = (
            capture_payload(cast(JsonValue, request["input"]), policy)
            if policy is not None
            else None
        )
        artifacts_raw = context.get("artifacts")
        if not isinstance(artifacts_raw, dict):
            raise TypeError("Capture context requires artifact versions.")
        artifacts = cast(dict[str, Any], artifacts_raw)
        identity: dict[str, Any] = {
            "attempt_id": attempt_id,
            "integration": request["integration"],
            "status": "pending",
        }
        metadata: dict[str, Any]
        if policy is not None and policy.get("mode") == "metadata-only":
            metadata = {}
        elif policy is not None:
            supplied = context.get("metadata")
            meta_value = capture_payload(
                cast(JsonValue, {} if supplied is None else supplied),
                policy,
            )["value"]
            if not isinstance(meta_value, dict):
                raise TypeError("Capture context metadata must stay a JSON object.")
            metadata = dict(cast(dict[str, Any], meta_value))
        else:
            raw_metadata = context.get("metadata")
            if raw_metadata is None:
                metadata = {}
            elif isinstance(raw_metadata, dict):
                metadata = dict(cast(dict[str, Any], raw_metadata))
            else:
                raise TypeError("Capture context metadata must stay a JSON object.")
        if policy is not None and captured is not None:
            identity["mode"] = policy["mode"]
            identity["truncated"] = captured["truncated"]
            identity["replay_eligible"] = False
        metadata["loopiter_capture"] = identity
        fields: dict[str, Any] = {
            "kind": "inference",
            "input": captured["value"] if captured is not None else request["input"],
            "artifacts": {**artifacts, "model": request["model"]},
            "metadata": metadata,
        }
        for key in ("id", "episode_id", "entity_id", "parent_execution_id"):
            if key in context and context[key] is not None:
                fields[key] = context[key]
        execution = cast(dict[str, Any], await options["loop"].record_execution(**fields))
        saved_identity = _identity(execution)
        if (
            saved_identity.get("attempt_id") != attempt_id
            or saved_identity.get("status") != "pending"
        ):
            raise LoopiterError(
                "capture_identity",
                "The sanitizer must preserve loopiter_capture identity and status.",
            )
        session = cls(options, execution, maximum)
        try:
            callback = options.get("on_execution")
            if callback is not None:
                await _resolve(callback(_copy_record(execution)))
        except BaseException:
            await session.finish("failed")
            raise
        return session

    def append(self, event: object) -> None:
        policy = _optional_policy(self._options.get("capture"))
        if (policy is not None and policy.get("mode") == "metadata-only") or self._truncated:
            return
        value = capture_json(event)
        self._bytes += json_utf8_size(value)
        if self._bytes > self._maximum and policy is not None:
            self._truncated = True
            self._events.clear()
            return
        if self._bytes > self._maximum:
            raise ValueError("Captured stream exceeded maximum_output_bytes.")
        self._events.append(value)

    async def finish(self, status: CaptureStatus, output: object = _MISSING) -> None:
        if self._finalization is not None:
            await self._finalization
            return
        policy = _optional_policy(self._options.get("capture"))
        if policy is not None and policy.get("mode") == "metadata-only":
            value: object = None
        elif output is _MISSING:
            value = {"events": list(self._events)}
        else:
            value = capture_json(output)
        if policy is not None:
            captured = capture_payload(cast(JsonValue, value), policy)
            self._truncated = self._truncated or captured["truncated"]
            value = {"omitted": True, "truncated": True} if self._truncated else captured["value"]
        if json_utf8_size(cast(JsonValue, value)) > self._maximum:
            if status in ("completed", "incomplete"):
                raise ValueError("Captured response exceeded maximum_output_bytes.")
            value = None
        self._finalization = self._finalize(status, cast(JsonValue, value))
        await self._finalization

    async def _finalize(self, status: CaptureStatus, value: JsonValue) -> None:
        previous = _identity(self.execution)
        policy = _optional_policy(self._options.get("capture"))
        identity = {**previous, "status": status}
        if policy is not None:
            identity["truncated"] = bool(self._truncated or previous.get("truncated"))
            identity["replay_eligible"] = False
        saved = cast(
            dict[str, Any],
            await self._options["loop"].complete_execution(
                self.execution["id"],
                expected_revision=self.execution["revision"],
                output=value,
                metadata={"loopiter_capture": identity},
            ),
        )
        saved_identity = _identity(saved)
        if saved_identity.get("status") != status or saved_identity.get(
            "attempt_id"
        ) != previous.get("attempt_id"):
            raise LoopiterError(
                "capture_identity",
                "The sanitizer must preserve loopiter_capture identity and status.",
            )
        callback = self._options.get("on_execution")
        if callback is not None:
            await _resolve(callback(_copy_record(saved)))


def _copy_record(value: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], capture_json(value))


def _optional_policy(value: object) -> CapturePolicy | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError("Invalid capture mode.")
    return cast(CapturePolicy, value)


def _identity(execution: Mapping[str, Any]) -> dict[str, Any]:
    metadata = execution.get("metadata")
    if not isinstance(metadata, dict):
        raise LoopiterError(
            "capture_identity",
            "The sanitizer must preserve loopiter_capture identity and status.",
        )
    identity = cast(dict[str, Any], metadata).get("loopiter_capture")
    if not isinstance(identity, dict):
        raise LoopiterError(
            "capture_identity",
            "The sanitizer must preserve loopiter_capture identity and status.",
        )
    return cast(dict[str, Any], identity)


__all__ = [
    "CaptureRequest",
    "CaptureSession",
    "CaptureStatus",
    "ExecutionContext",
    "capture_json",
    "capture_snapshot",
    "clone_with_overrides",
    "finish_status",
    "resolve_context",
]
