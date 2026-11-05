# Observing an AI application

Use the existing provider wrappers for model calls, an observer for application/tool/retrieval functions, and an exporter for existing OpenTelemetry instrumentation. These APIs write to your configured `FeedbackLoop` store; they do not install a second tracer provider or connect to the hosted Loopiter platform automatically.

```ts
import { FeedbackLoop, InMemoryStore } from "loopiter";
import { createObserver } from "loopiter/integrations/observe";

// Use a durable production store; in-memory storage is only for this example.
const loop = new FeedbackLoop({ store: new InMemoryStore(), namespace: "support" });
const observer = createObserver({ loop, capture: { mode: "redacted" } });

// Derive context from authenticated server state, not from a feedback form.
const answer = await observer.observe("support.answer", () => generateAnswer(), {
  kind: "workflow",
  input: { question },
  context: { id: requestId, releaseId, learningContext: { tenantId, policyVersion } },
});
```

The wrapper preserves the returned value and original application errors. Async iterables remain lazy and propagate cancellation; stream bodies are never buffered by this generic observer. It records chunk counts and lifecycle status. A stream never consumed remains pending. Await ordinary observations and finish/cancel streams before shutting down your store.

Telemetry failures default to fail-open with an optional `onError` callback. Set `failureMode: "closed"` to require persistence. Supplying a durable `context.id` always requires a successful, unique claim before executing the application: repeats or ambiguous claims fail rather than regenerate. This is not a result cache; recover results from the application's journal. The observer never retries the business operation.

## Existing OpenTelemetry

```ts
import { createLoopiterSpanExporter } from "loopiter/integrations/otel";

const exporter = createLoopiterSpanExporter({
  loop,
  capture: { mode: "metadata-only" },
  select: span => Boolean(span.attributes["gen_ai.request.model"]),
  context: span => applicationContextForSpan(span),
});
// Add this exporter using your existing tracer provider's SpanProcessor configuration.
// Do not initialize another global provider.
// During shutdown, flush your processor first, then:
await exporter.forceFlush();
await exporter.shutdown();
```

The exporter accepts a structural subset of OpenTelemetry ReadableSpan. It uses stable trace/span IDs for deduplication, retains exact model versions, separates input/output token usage and maps explicit OK/ERROR status to completed/failed. UNSET remains unknown. Business success must come from the application. Parent trace/span identity is retained as metadata so partial or child-before-parent exports do not require a parent execution to exist. Arbitrary span attributes, names, events and error messages are not copied. Optional payload capture reads `gen_ai.input.messages` and `gen_ai.output.messages`.

Export failure returns a failed callback so the caller can retry the same spans. An already stored span with different content conflicts instead of silently overwriting evidence. Stable IDs deduplicate repeated exports through this bridge; independently instrumenting the same call through multiple unrelated wrappers can still create duplicate records. Choose one owner for each observed operation.

## Capture policy

New observers and exporters default to `metadata-only`. Existing OpenAI and Vercel AI SDK wrappers preserve their full-capture default and now accept `capture`:

```ts
const options = {
  loop,
  context: () => ({ artifacts: { prompt: releaseId } }),
  capture: { mode: "redacted" as const, maximumBytes: 65536 },
};
```

- `metadata-only` omits input/output bodies. Provider wrappers also omit arbitrary application metadata in this mode. Explicit context IDs should be opaque identifiers.
- `redacted` removes credential-like field names (matched as tokens, including separators and mixed case), private keys, known token patterns, labeled secrets, and URL userinfo before size limits. Node removes `http` and `https` userinfo. Python removes userinfo for any scheme. It does not remove every secret shape. Add a domain-specific `redact` callback for anything else. Pattern redaction is not a guarantee of anonymization.
- `full` explicitly retains payloads within the configured bounds. Optional custom redaction still applies.

Oversized payloads are omitted with `truncated: true`; partial strings are not silently treated as complete answers. Application values are not mutated. `loopiterCapture` includes capture mode and an explicit `replayEligible: false` for these observational paths. A full provider trace still does not prove that tool effects, retrieval state, application code and generation settings can be replayed faithfully. Use the native application integration and approved frozen inputs for autonomous releases.

Retention is controlled by the configured store and application. This API does not add an automatic deletion scheduler, encrypt arbitrary stores, or forward metadata-only telemetry into training.

## Python

The Python modules are `loopiter.integrations.observe`, `loopiter.integrations.otel`, `loopiter.integrations.privacy`, and `loopiter.integrations.capture`. Names are snake_case. Stored record fields follow the Python SDK (`loopiter_capture`, `attempt_id`, `replay_eligible`, `observe_only`, `trace_id`, `parent_execution_id`, `input_tokens`). JSON payload sentinels stay the same as Node: `omitted`, `truncated`, `bytes`, `events`, and `chunks`.

```python
import asyncio

from loopiter import FeedbackLoop, InMemoryStore
from loopiter.integrations.observe import create_observer
from loopiter.integrations.otel import create_loopiter_span_exporter


async def main():
    loop = FeedbackLoop(store=InMemoryStore(), namespace="support/dev")
    observer = create_observer(loop=loop, capture={"mode": "redacted"})

    async def generate():
        return {"answer": "synthetic"}

    await observer.observe(
        "support.answer",
        generate,
        kind="workflow",
        input={"question": "synthetic"},
        context={"id": "request-1", "release_id": "support-v1"},
    )
    exporter = create_loopiter_span_exporter(
        loop=loop,
        capture={"mode": "metadata-only"},
        select=lambda span: bool(span.attributes.get("gen_ai.request.model")),
    )
    await exporter.force_flush()
    await exporter.shutdown()
    await loop.close()


if __name__ == "__main__":
    asyncio.run(main())
```

`create_loopiter_span_exporter` accepts a structural span: `span_context()` returns `trace_id` and `span_id`, `start_time` and `end_time` are `(seconds, nanoseconds)`, and `status["code"]` uses the JavaScript OpenTelemetry codes (UNSET `0`, OK `1`, ERROR `2`). Python OpenTelemetry spans are accepted by duck typing. `status.status_code` is a `StatusCode` enum with the same UNSET 0, OK 1, and ERROR 2 values, mapped by name. Export returns `{"code": 0}` or `{"code": 1, "error": ...}`. `0` and `1` match Node. Shutdown returns code `1` with `Exporter is shut down.`

`opentelemetry_span_exporter` is the only function that imports the OpenTelemetry SDK. Install it with `pip install 'loopiter[otel]'`. `export` runs on the processor worker thread. `shutdown` and `force_flush` finish when no loop is running, and when a loop is running they schedule the work and return without raising. `PostgresStore` is not supported on that worker-thread adapter; await `create_loopiter_span_exporter` on the application loop instead.

Breaking out of `async for` does not close the iterator. Await `aclose()` or leave the `async with` block so a partially read stream is recorded as `cancelled` rather than left `pending`. A stream that is never iterated stays pending. Telemetry defaults to fail-open. `failure_mode="closed"` requires persistence. A caller-supplied `context["id"]` is claimed before the operation even when persistence is otherwise fail-open, and a repeat raises rather than running the operation again.

`capture_payload` and `redact_capture` implement the same modes as Node: `metadata-only`, `redacted`, and `full`. `maximum_bytes` defaults to 65536 and must be an integer from 128 through 1048576. Redaction runs before the size check. Oversized values are omitted whole. `CaptureSession` is the shared provider-capture contract: pending record, bounded `append`, and `finish` with `completed`, `incomplete`, `cancelled`, or `failed`. `with_loopiter` uses the same capture policy and defaults to metadata-only.
