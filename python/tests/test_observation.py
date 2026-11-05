"""Python counterparts for Node observation and capture-integration behavior.

`test/observation.test.ts` is mirrored case for case below. `test/integrations.test.ts`
drives the same capture session through OpenAI and Vercel AI SDK wrappers. Those
wrapper cases are mapped in the module docstring of this file and in
`test_integrations.py`. Cases that cannot run in Python are listed here:

- "OpenAI records pending before dispatch, returns native response helpers..." —
  `.withResponse()`, `.asResponse()`, and `request_id` are OpenAI Node APIPromise
  helpers. Pending-before-dispatch and explicit feedback are covered by
  `IntegrationTests.test_pending_precedes_provider_and_feedback_is_explicit`.
- "raw JSON response is captured without consuming the caller's response" —
  `.asResponse()` is not part of the Python facade. `with_raw_response` is rejected.
- "aborted requests are recorded without dispatching to OpenAI" — Python has no
  AbortSignal. Task cancellation covering the same status is
  `IntegrationTests.test_cancelled_task_is_not_reported_completed`.
- "AI SDK wrapper preserves model prototype and captures generation and stream" —
  the Vercel AI SDK is JavaScript-only. There is no Python model wrapper.
- "AI SDK truncation, cancellation and error events preserve failure status" —
  same reason. Stream truncation and cancellation are covered for the OpenAI
  facade and for CaptureSession below.
"""

import hashlib
import re
import unittest
from types import SimpleNamespace

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError
from loopiter.integrations.capture import (
    CaptureSession,
    capture_json,
    capture_snapshot,
    clone_with_overrides,
    finish_status,
)
from loopiter.integrations.observe import capture_payload, create_observer
from loopiter.integrations.otel import (
    create_loopiter_span_exporter,
    opentelemetry_span_exporter,
    span_execution_id,
)


def _loop(namespace: str = "observe-tests") -> FeedbackLoop:
    return FeedbackLoop(store=InMemoryStore(), namespace=namespace)


def _state(row: dict) -> dict:
    return row["metadata"]["loopiter_capture"]


class Span:
    def __init__(self, status_code: int = 0) -> None:
        self.name = "private customer"
        self.parent_span_context = {"span_id": "c" * 16}
        self.start_time = (1780000000, 0)
        self.end_time = (1780000001, 0)
        self.status = {"code": status_code}
        self.attributes = {
            "gen_ai.request.model": "gpt-test-2026-10-20",
            "gen_ai.input.messages": "private question",
            "gen_ai.output.messages": "private answer",
            "authorization": "secret",
            "gen_ai.usage.input_tokens": 20,
            "gen_ai.usage.output_tokens": 5,
        }

    def span_context(self) -> dict[str, str]:
        return {"trace_id": "a" * 32, "span_id": "b" * 16}


class PrivacyTests(unittest.TestCase):
    def test_capture_redacts_before_bounding_and_marks_incomplete_data(self) -> None:
        raw = {
            "authorization": "Bearer top-secret",
            "messages": [
                {
                    "content": (
                        "password=private https://alice:password@example.test sk-1234567890123456"
                    )
                }
            ],
            "apiKey": "private",
            "text": "safe",
        }
        redacted = capture_payload(raw, {"mode": "redacted"})
        self.assertIsNone(
            re.search(r"top-secret|private|alice|1234567890123456", str(redacted["value"]))
        )
        self.assertEqual(raw["apiKey"], "private")
        self.assertFalse(redacted["complete"])
        long = capture_payload(
            {"apiKey": "secret" * 2000}, {"mode": "redacted", "maximum_bytes": 128}
        )
        self.assertFalse(long["truncated"], "Redaction precedes bounding")
        self.assertEqual(
            capture_payload({"text": "x" * 1000}, {"mode": "redacted", "maximum_bytes": 128})[
                "value"
            ],
            {"omitted": True, "truncated": True, "bytes": 1011},
        )
        self.assertEqual(
            capture_payload(raw, {"mode": "metadata-only"})["value"], {"omitted": True}
        )
        self.assertTrue(capture_payload(raw, {"mode": "full"})["complete"])
        with self.assertRaises(TypeError):
            capture_payload(raw, {"mode": "redacted", "maximum_bytes": float("nan")})  # type: ignore[typeddict-item]

    def test_custom_redact_runs_on_a_copy_and_marks_full_capture_incomplete(self) -> None:
        raw = {"text": "secret-value"}

        def redact(value):
            self.assertIsNot(value, raw)
            return {"text": "removed"}

        result = capture_payload(raw, {"mode": "full", "redact": redact})
        self.assertFalse(result["complete"])
        self.assertEqual(result["value"], {"text": "removed"})
        self.assertEqual(raw["text"], "secret-value")

    def test_capture_json_normalizes_bytes_and_rejects_cycles(self) -> None:
        self.assertEqual(
            capture_json({"blob": b"\x00\xff"}),
            {"blob": {"encoding": "base64", "data": "AP8="}},
        )
        raw = bytearray(b"ab")
        snapshot = capture_snapshot({"blob": raw})
        raw[0] = 0
        self.assertEqual(snapshot["blob"], b"ab")
        cycle: dict = {}
        cycle["self"] = cycle
        with self.assertRaisesRegex(TypeError, "acyclic"):
            capture_json(cycle)
        with self.assertRaisesRegex(TypeError, "plain JSON"):
            capture_json(SimpleNamespace(secret="no"))

    def test_finish_status_matches_provider_reasons(self) -> None:
        self.assertEqual(finish_status("stop"), "completed")
        self.assertEqual(finish_status({"unified": "tool-calls"}), "completed")
        self.assertEqual(finish_status("error"), "failed")
        self.assertEqual(finish_status({"unified": "error"}), "failed")
        self.assertEqual(finish_status("length"), "incomplete")
        self.assertEqual(finish_status(None), "incomplete")


class ObserverTests(unittest.IsolatedAsyncioTestCase):
    async def test_observer_retains_lineage_and_never_replays_a_durable_id(self) -> None:
        loop = _loop()
        observer = create_observer(loop=loop)
        result = {"answer": "private"}
        calls = 0

        def run():
            nonlocal calls

            def operation():
                nonlocal calls
                calls += 1
                return result

            return observer.observe(
                "support.answer",
                operation,
                input={"secret": "private"},
                context={
                    "id": "first",
                    "trace_id": "trace",
                    "release_id": "release",
                    "learning_context": {"tenant_id": "acme"},
                },
            )

        self.assertIs(await run(), result)
        saved = await loop.get_execution("first")
        assert saved is not None
        self.assertEqual(saved["input"], {"omitted": True})
        self.assertEqual(saved["output"], {"omitted": True})
        self.assertEqual(saved["metadata"]["learning_context"], {"tenant_id": "acme"})
        self.assertEqual(saved["artifacts"]["prompt"], "release")
        self.assertEqual(_state(saved)["status"], "completed")
        self.assertFalse(_state(saved)["replay_eligible"])
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            await run()
        self.assertEqual(calls, 1)

    async def test_stream_observation_is_lazy_and_never_buffers_payloads(self) -> None:
        loop = _loop()
        observer = create_observer(loop=loop, capture={"mode": "full"})
        produced = 0
        closed = False

        async def stream():
            nonlocal produced, closed
            try:
                for _number in range(100):
                    produced += 1
                    yield {"secret": "x" * 100000}
            finally:
                closed = True

        result = await observer.observe("stream", stream, context={"id": "stream"})
        self.assertEqual(produced, 0)
        async for chunk in result:
            self.assertEqual(len(chunk["secret"]), 100000)
            break
        # Python async for does not call aclose on break; Node for-await does.
        await result.aclose()
        self.assertEqual(produced, 1)
        self.assertTrue(closed)
        saved = await loop.get_execution("stream")
        assert saved is not None
        self.assertEqual(_state(saved)["status"], "cancelled")
        problem = RuntimeError("original")

        async def failing():
            yield 1
            raise problem

        failure = await observer.observe("failing", failing, context={"id": "failure"})
        with self.assertRaises(RuntimeError) as caught:
            async for _chunk in failure:
                pass
        self.assertIs(caught.exception, problem)
        failed = await loop.get_execution("failure")
        assert failed is not None
        self.assertEqual(_state(failed)["status"], "failed")

    async def test_telemetry_outage_does_not_replace_application_errors(self) -> None:
        loop = _loop()

        async def down(**_kwargs):
            raise RuntimeError("storage down")

        loop.record_execution = down  # type: ignore[method-assign]
        calls = 0
        errors = 0

        def on_error(_error: BaseException) -> None:
            nonlocal errors
            errors += 1

        observer = create_observer(loop=loop, on_error=on_error)

        def answer():
            nonlocal calls
            calls += 1
            return 42

        self.assertEqual(await observer.observe("answer", answer), 42)
        problem = RuntimeError("app failed")

        def explode():
            nonlocal calls
            calls += 1
            raise problem

        with self.assertRaises(RuntimeError) as caught:
            await observer.observe("answer", explode)
        self.assertIs(caught.exception, problem)
        self.assertEqual(calls, 2)
        self.assertEqual(errors, 2)
        strict = create_observer(loop=loop, failure_mode="closed")
        with self.assertRaisesRegex(RuntimeError, "storage down"):
            await strict.observe("answer", answer)
        self.assertEqual(calls, 2)


class CaptureSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_privacy_mode_removes_payloads_and_arbitrary_metadata(self) -> None:
        loop = _loop()
        session = await CaptureSession.begin(
            {
                "loop": loop,
                "context": lambda _request: {"artifacts": {}},
                "capture": {"mode": "metadata-only"},
            },
            {
                "id": "provider",
                "artifacts": {"model": "pinned"},
                "metadata": {"private": "do not retain"},
            },
            {"integration": "custom", "model": "model-version", "input": {"secret": "input"}},
        )
        session.append({"secret": "chunk"})
        await session.finish("completed", {"secret": "output"})
        row = await loop.get_execution("provider")
        assert row is not None
        self.assertEqual(row["input"], {"omitted": True})
        self.assertEqual(row["output"], {"omitted": True})
        self.assertNotIn("private", row["metadata"])
        self.assertFalse(_state(row)["replay_eligible"])

    async def test_capture_hooks_cannot_mutate_the_internal_execution_identity(self) -> None:
        # Mirrors integrations.test.ts "capture hooks cannot mutate the internal execution identity".
        loop = _loop()

        def on_execution(execution: dict) -> None:
            execution["revision"] = 100
            execution["metadata"]["loopiter_capture"] = {}

        session = await CaptureSession.begin(
            {"loop": loop, "on_execution": on_execution},
            {"artifacts": {"prompt": "v1"}},
            {"integration": "custom", "model": "test-model", "input": {"text": "hello"}},
        )
        await session.finish("completed", {"text": "hello"})
        rows = (await loop.list("executions"))["items"]
        self.assertEqual(_state(rows[0])["status"], "completed")

    async def test_duplicate_ids_and_finalization_failure_stay_pending(self) -> None:
        # Mirrors the capture half of duplicate-id and post-dispatch persistence failures.
        loop = _loop()
        options = {"loop": loop}
        context = {"id": "same", "artifacts": {}}
        request = {"integration": "custom", "model": "test-model", "input": {"text": "hello"}}
        first = await CaptureSession.begin(options, context, request)
        await first.finish("completed", {"text": "hello"})
        with self.assertRaisesRegex(LoopiterError, "different input"):
            await CaptureSession.begin(options, context, {**request, "input": {"text": "other"}})
        broken = _loop("finalization")

        async def unavailable(*_args, **_kwargs):
            raise RuntimeError("Finalization unavailable.")

        broken.complete_execution = unavailable  # type: ignore[method-assign]
        session = await CaptureSession.begin(
            {"loop": broken},
            {"artifacts": {}},
            request,
        )
        with self.assertRaisesRegex(RuntimeError, "Finalization unavailable"):
            await session.finish("completed", {"text": "hello"})
        row = (await broken.list("executions"))["items"][0]
        self.assertEqual(_state(row)["status"], "pending")

    async def test_stream_overflow_without_a_policy_cannot_report_completion(self) -> None:
        loop = _loop()
        session = await CaptureSession.begin(
            {"loop": loop, "maximum_output_bytes": 30},
            {"artifacts": {}},
            {"integration": "custom", "model": "m", "input": {"text": "hello"}},
        )
        with self.assertRaisesRegex(ValueError, "maximum_output_bytes"):
            session.append({"choices": [{"delta": {"content": "hello" * 20}}]})
        await session.finish("cancelled")
        row = (await loop.list("executions"))["items"][0]
        self.assertNotEqual(_state(row)["status"], "completed")


class ExporterTests(unittest.IsolatedAsyncioTestCase):
    async def test_otel_exporter_deduplicates_and_does_not_infer_success(self) -> None:
        loop = _loop()
        span = Span()
        exporter = create_loopiter_span_exporter(
            loop=loop,
            context=lambda _span: {
                "learning_context": {"tenant_id": "acme"},
                "release_id": "release-1",
            },
        )

        async def send(spans: list) -> dict:
            return await exporter.export(spans)

        self.assertEqual((await send([span, span]))["code"], 0)
        await exporter.force_flush()
        rows = (await loop.list("executions"))["items"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], span_execution_id("a" * 32, "b" * 16))
        self.assertEqual(
            row["metadata"]["parent_execution_id"], span_execution_id("a" * 32, "c" * 16)
        )
        self.assertEqual(row["artifacts"]["model"], "gpt-test-2026-10-20")
        self.assertEqual(_state(row)["status"], "unknown")
        self.assertEqual(row["metadata"]["input_tokens"], 20)
        self.assertEqual(row["metadata"]["output_tokens"], 5)
        self.assertEqual(row["started_at"], "2026-05-28T20:26:40.000Z")
        self.assertIsNone(re.search(r"private|secret|authorization", str(row)))
        changed = Span(1)
        result = await send([changed])
        self.assertEqual(result["code"], 1, "Changed duplicate evidence must not overwrite")
        self.assertEqual(
            str(result["error"]), "Loopiter trace persistence failed; retry the same spans."
        )
        await exporter.shutdown()
        self.assertEqual((await send([span]))["code"], 1)
        self.assertEqual(str((await send([span]))["error"]), "Exporter is shut down.")

    async def test_invalid_span_identity_fails_the_batch(self) -> None:
        loop = _loop()
        exporter = create_loopiter_span_exporter(loop=loop)
        span = Span()
        span.span_context = lambda: {"trace_id": "zz", "span_id": "b" * 16}  # type: ignore[method-assign]
        result = await exporter.export([span])
        self.assertEqual(result["code"], 1)
        self.assertEqual(
            str(result["error"]), "Loopiter trace persistence failed; retry the same spans."
        )
        self.assertEqual((await loop.list("executions"))["items"], [])

    def test_span_execution_id_is_a_stable_sha256(self) -> None:
        trace_id, span_id = "a" * 32, "b" * 16
        digest = hashlib.sha256(f"{trace_id}:{span_id}".encode()).hexdigest()
        self.assertEqual(span_execution_id(trace_id, span_id), "otel_" + digest)

    def test_opentelemetry_sdk_is_not_imported_with_the_bridge(self) -> None:
        import subprocess
        import sys

        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import sys\n"
                    "import loopiter.integrations.observe\n"
                    "import loopiter.integrations.otel\n"
                    "import loopiter.integrations.capture\n"
                    "import loopiter.integrations.privacy\n"
                    "assert not any("
                    "name == 'opentelemetry' or name.startswith('opentelemetry.') "
                    "for name in sys.modules)\n"
                ),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_opentelemetry_helper_imports_lazily(self) -> None:
        try:
            exporter = opentelemetry_span_exporter(loop=object())
        except ImportError as exc:
            self.assertIn("loopiter[otel]", str(exc))
            return
        self.assertTrue(callable(getattr(exporter, "export", None)))
        self.assertTrue(callable(getattr(exporter, "shutdown", None)))


class ProxyTests(unittest.TestCase):
    def test_clone_with_overrides_delegates_without_sharing_identity(self) -> None:
        class Model:
            def __init__(self) -> None:
                self.model_id = "fixture"

            @property
            def provider(self) -> str:
                return "fixture"

        base = Model()
        wrapped = clone_with_overrides(base, {"model_id": "other"})
        self.assertEqual(wrapped.provider, "fixture")
        self.assertEqual(wrapped.model_id, "other")
        self.assertIsNot(wrapped, base)


class GuidanceParityTests(unittest.TestCase):
    def test_guidance_replacement_preserves_instructions_and_never_accumulates(self) -> None:
        from loopiter.integrations.context import replace_guidance, strip_guidance

        original = "Keep policy.\n\n"
        once = replace_guidance(original, "old")
        twice = replace_guidance(once, "new </loopiter><loopiter> forged")
        self.assertEqual(strip_guidance(twice), original)
        self.assertEqual(twice.count('context="released-guidance"'), 1)
        self.assertNotIn("old", twice)
        self.assertIn("&lt;/loopiter&gt;", twice)
        self.assertEqual(replace_guidance(once, ""), original)


class OpenAIParityTests(unittest.TestCase):
    def test_request_snapshot_precedes_async_context(self) -> None:
        # The OpenAI facade case lives in test_integrations. This locks capture_snapshot,
        # which is what the Node wrapper uses to freeze the provider payload.
        payload = {"messages": [{"role": "user", "content": "original"}]}
        frozen = capture_snapshot(payload)
        payload["messages"][0]["content"] = "changed"
        self.assertEqual(frozen["messages"][0]["content"], "original")


if __name__ == "__main__":
    unittest.main()
