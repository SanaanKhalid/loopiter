"""OpenTelemetry span bridge. No SDK or tracer provider is installed on import.

Structural spans use the Node ReadableSpan shape in snake_case: span_context(),
start_time/end_time as (seconds, nanoseconds), and status {"code": n} with the
JavaScript status codes (UNSET 0, OK 1, ERROR 2). Python OpenTelemetry spans are
accepted by duck typing; their StatusCode names are mapped onto those codes
because the Python enum numbers differ.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import math
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, NotRequired, TypedDict, cast

from .capture import capture_json
from .observe import ObservationContext
from .privacy import CapturePolicy, JsonValue, capture_payload, checked_policy

_TRACE = re.compile(r"^[a-f0-9]{32}$", re.IGNORECASE | re.ASCII)
_SPAN = re.compile(r"^[a-f0-9]{16}$", re.IGNORECASE | re.ASCII)
_ZERO = re.compile(r"^0+$", re.ASCII)
_STATUS_NAME = {"UNSET": 0, "OK": 1, "ERROR": 2}


class ExportResult(TypedDict):
    code: int
    error: NotRequired[BaseException]


class _Span:
    def __init__(
        self,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None,
        start: tuple[int, int],
        end: tuple[int, int],
        status_code: int,
        attributes: dict[str, object],
    ) -> None:
        self.trace_id = trace_id
        self.span_id = span_id
        self.parent_span_id = parent_span_id
        self.start = start
        self.end = end
        self.status_code = status_code
        self.attributes = attributes


def span_execution_id(trace_id: str, span_id: str) -> str:
    digest = hashlib.sha256(f"{trace_id}:{span_id}".encode()).hexdigest()
    return "otel_" + digest


def _invalid() -> TypeError:
    return TypeError("Invalid OTel trace/span identity.")


def _identity(value: object, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None or _ZERO.fullmatch(value):
        raise _invalid()
    return value


def _pair(value: object) -> tuple[int, int]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise _invalid()
    pair = cast(Sequence[object], value)
    if len(pair) != 2:
        raise _invalid()
    seconds, nanos = pair[0], pair[1]
    if (
        isinstance(seconds, bool)
        or isinstance(nanos, bool)
        or not isinstance(seconds, int)
        or not isinstance(nanos, int)
    ):
        raise _invalid()
    return seconds, nanos


def _status_code(status: object) -> int:
    if isinstance(status, Mapping):
        code = cast(Mapping[str, object], status).get("code")
        if isinstance(code, bool) or not isinstance(code, int):
            raise _invalid()
        return code
    named = getattr(status, "status_code", None)
    if named is not None:
        mapped = _STATUS_NAME.get(str(getattr(named, "name", "")))
        if mapped is None:
            raise _invalid()
        return mapped
    code = getattr(status, "code", None)
    if isinstance(code, bool) or not isinstance(code, int):
        raise _invalid()
    return code


def _from_nanos(value: object) -> tuple[int, int]:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid()
    seconds, nanos = divmod(value, 1_000_000_000)
    return seconds, nanos


def _normalize(span: object) -> _Span:
    reader = getattr(span, "span_context", None)
    if callable(reader):
        context = reader()
        if not isinstance(context, Mapping):
            raise _invalid()
        identity = cast(Mapping[str, object], context)
        trace_id = _identity(identity.get("trace_id"), _TRACE)
        span_id = _identity(identity.get("span_id"), _SPAN)
        parent_span_id = _parent_id(getattr(span, "parent_span_context", None))
        start = _pair(getattr(span, "start_time", None))
        end = _pair(getattr(span, "end_time", None))
    else:
        getter = getattr(span, "get_span_context", None)
        if not callable(getter):
            raise _invalid()
        context = getter()
        trace_id = _identity(_hex(getattr(context, "trace_id", None), 32), _TRACE)
        span_id = _identity(_hex(getattr(context, "span_id", None), 16), _SPAN)
        parent_span_id = _otel_parent(getattr(span, "parent", None))
        start = _from_nanos(getattr(span, "start_time", None))
        end = _from_nanos(getattr(span, "end_time", None))
    attributes = getattr(span, "attributes", {}) or {}
    if not isinstance(attributes, Mapping):
        raise _invalid()
    copied = {str(key): item for key, item in cast(Mapping[object, object], attributes).items()}
    return _Span(
        trace_id,
        span_id,
        parent_span_id,
        start,
        end,
        _status_code(getattr(span, "status", None)),
        copied,
    )


def _parent_id(parent: object) -> str | None:
    if not parent:
        return None
    if not isinstance(parent, Mapping):
        raise _invalid()
    span_id = cast(Mapping[str, object], parent).get("span_id")
    if not isinstance(span_id, str):
        raise _invalid()
    return span_id


def _otel_parent(parent: object) -> str | None:
    if parent is None:
        return None
    span_id = getattr(parent, "span_id", None)
    if span_id is None:
        return None
    return _identity(_hex(span_id, 16), _SPAN)


def _hex(value: object, width: int) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid()
    return format(value, f"0{width}x")


def _stamp(time: tuple[int, int]) -> str:
    millis = math.trunc(time[0] * 1000 + time[1] / 1e6)
    seconds, ms = divmod(millis, 1000)
    moment = datetime.fromtimestamp(seconds, UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def _token(attributes: Mapping[str, object], key: str) -> float | None:
    value = attributes.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return value


def _capture_status(code: int) -> str:
    # Ending a span does not prove task success, especially UNSET status.
    if code == 2:
        return "failed"
    if code == 1:
        return "completed"
    return "unknown"


class LoopiterSpanExporter:
    def __init__(
        self,
        loop: Any,
        policy: CapturePolicy,
        context: Callable[[object], ObservationContext] | None,
        select: Callable[[object], bool] | None,
    ) -> None:
        self._loop = loop
        self._policy = policy
        self._context = context
        self._select = select
        self._pending: set[asyncio.Task[None]] = set()
        self._closed = False

    async def export(self, spans: Sequence[object]) -> ExportResult:
        if self._closed:
            return {"code": 1, "error": RuntimeError("Exporter is shut down.")}
        task = asyncio.create_task(self._write(tuple(spans)))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)
        try:
            await task
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = RuntimeError("Loopiter trace persistence failed; retry the same spans.")
            error.__cause__ = exc
            return {"code": 1, "error": error}
        return {"code": 0}

    async def force_flush(self) -> None:
        pending = tuple(self._pending)
        if pending:
            await asyncio.gather(*pending)

    async def shutdown(self) -> None:
        self._closed = True
        await self.force_flush()

    async def _write(self, spans: Sequence[object]) -> None:
        for span in spans:
            if self._select is not None and not self._select(span):
                continue
            normalized = _normalize(span)
            if self._context is None:
                context_value: dict[str, Any] = {}
            else:
                context_value = cast(dict[str, Any], self._context(span))
            ctx_raw = capture_json(context_value)
            if not isinstance(ctx_raw, dict):
                raise TypeError("Observation context must be a plain dict.")
            ctx = cast(dict[str, Any], ctx_raw)
            attributes = normalized.attributes
            incoming = _bounded(
                None
                if self._policy["mode"] == "metadata-only"
                else attributes.get("gen_ai.input.messages"),
                self._policy,
            )
            outgoing = _bounded(
                None
                if self._policy["mode"] == "metadata-only"
                else attributes.get("gen_ai.output.messages"),
                self._policy,
            )
            model = attributes.get("gen_ai.request.model")
            artifacts: dict[str, Any] = {}
            if isinstance(model, str):
                artifacts["model"] = model
            if ctx.get("release_id"):
                artifacts["prompt"] = ctx["release_id"]
            metadata: dict[str, Any] = {
                **ctx,
                "trace_id": normalized.trace_id,
                "span_id": normalized.span_id,
                "observe_only": True,
            }
            if normalized.parent_span_id is not None:
                metadata["parent_span_id"] = normalized.parent_span_id
                metadata["parent_execution_id"] = span_execution_id(
                    normalized.trace_id, normalized.parent_span_id
                )
            metadata["loopiter_capture"] = {
                "integration": "opentelemetry",
                "mode": self._policy["mode"],
                "status": _capture_status(normalized.status_code),
                "truncated": incoming["truncated"] or outgoing["truncated"],
                "replay_eligible": False,
            }
            # Deliberate allowlist: arbitrary attributes, names, and events may contain secrets.
            for source, dest in (
                ("gen_ai.usage.input_tokens", "input_tokens"),
                ("gen_ai.usage.output_tokens", "output_tokens"),
            ):
                token = _token(attributes, source)
                if token is not None:
                    metadata[dest] = token
            fields: dict[str, Any] = {
                "id": span_execution_id(normalized.trace_id, normalized.span_id),
                "kind": "inference" if model else "custom",
                "input": incoming["value"],
                "output": outgoing["value"],
                "started_at": _stamp(normalized.start),
                "completed_at": _stamp(normalized.end),
                "artifacts": artifacts,
                "metadata": metadata,
            }
            if ctx.get("episode_id"):
                fields["episode_id"] = ctx["episode_id"]
            if ctx.get("entity_id"):
                fields["entity_id"] = ctx["entity_id"]
            await self._loop.record_execution(**fields)


def _bounded(value: object, policy: CapturePolicy) -> Mapping[str, Any]:
    payload: JsonValue = None if value is None else capture_json(value)
    return capture_payload(payload, policy)


def create_loopiter_span_exporter(
    *,
    loop: Any,
    capture: CapturePolicy | None = None,
    context: Callable[[object], ObservationContext] | None = None,
    select: Callable[[object], bool] | None = None,
) -> LoopiterSpanExporter:
    """Application-controlled mapping; never trust span attributes as authorization."""
    return LoopiterSpanExporter(loop, checked_policy(capture), context, select)


def opentelemetry_span_exporter(
    *,
    loop: Any,
    capture: CapturePolicy | None = None,
    context: Callable[[object], ObservationContext] | None = None,
    select: Callable[[object], bool] | None = None,
) -> Any:
    """Return an OpenTelemetry Python SpanExporter. The SDK is imported only here.

    Install ``loopiter[otel]``. BatchSpanProcessor calls export on a worker thread,
    where this adapter uses asyncio.run. A call from a thread that is already
    running the application's event loop raises RuntimeError; await
    LoopiterSpanExporter.export from that task instead.
    """
    try:
        export_api = importlib.import_module("opentelemetry.sdk.trace.export")
    except ImportError as exc:
        raise ImportError(
            "OpenTelemetry export requires the optional extra: pip install 'loopiter[otel]'"
        ) from exc
    span_exporter = export_api.SpanExporter
    success = export_api.SpanExportResult.SUCCESS
    failure = export_api.SpanExportResult.FAILURE

    bridge = create_loopiter_span_exporter(
        loop=loop, capture=capture, context=context, select=select
    )

    class _Adapter(span_exporter):
        def export(self, spans: Sequence[object]) -> Any:
            result = _run(bridge.export(spans))
            if result["code"] == 0:
                return success
            return failure

        def shutdown(self) -> None:
            _run(bridge.shutdown())

        def force_flush(self, timeout_millis: int = 30000) -> bool:
            _run(bridge.force_flush())
            return True

    return _Adapter()


def _run(coro: Awaitable[Any]) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)  # type: ignore[arg-type]
    close = getattr(coro, "close", None)
    if callable(close):
        close()
    raise RuntimeError(
        "OpenTelemetry called the exporter on a running event loop. "
        "Use BatchSpanProcessor, which exports on a worker thread, or await "
        "LoopiterSpanExporter.export from the application task."
    )


__all__ = [
    "ExportResult",
    "LoopiterSpanExporter",
    "create_loopiter_span_exporter",
    "opentelemetry_span_exporter",
    "span_execution_id",
]
