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
- `redacted` removes common structured credential fields, authorization headers, private keys, known token patterns, URL passwords and labeled secrets before size limits. Add a domain-specific `redact` callback for customer-specific PII. Pattern redaction is not a guarantee of anonymization.
- `full` explicitly retains payloads within the configured bounds. Optional custom redaction still applies.

Oversized payloads are omitted with `truncated: true`; partial strings are not silently treated as complete answers. Application values are not mutated. `loopiterCapture` includes capture mode and an explicit `replayEligible: false` for these observational paths. A full provider trace still does not prove that tool effects, retrieval state, application code and generation settings can be replayed faithfully. Use the native application integration and approved frozen inputs for autonomous releases.

Retention is controlled by the configured store and application. This API does not add an automatic deletion scheduler, encrypt arbitrary stores, or forward metadata-only telemetry into training.
