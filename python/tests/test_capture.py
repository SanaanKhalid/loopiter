import asyncio
import json
import unittest

from loopiter import FeedbackLoop, InMemoryStore
from loopiter.integrations.import_batch import import_batch
from loopiter.integrations.observe import create_observer
from loopiter.integrations.privacy import capture_payload

WHEN = "2026-03-01T15:04:05.000Z"


def _record(key, stage, prompt, **extra):
    body = {
        "idempotencyKey": key,
        "occurredAt": WHEN,
        "status": "success",
        "stageId": stage,
        "versions": {"prompt": prompt, "model": "fixture"},
        "usage": {"state": "unknown"},
    }
    body.update(extra)
    return body


class _Stall:
    def __init__(self):
        self.calls = 0
        self.completes = []
        self.release = None

    async def get_execution(self, _key):
        return None

    async def record_execution(self, **kwargs):
        self.calls += 1
        pending = asyncio.get_running_loop().create_future()
        self.release = pending
        await pending
        return {
            "id": kwargs["id"],
            "revision": 1,
            "metadata": {"loopiter_capture": dict(kwargs["metadata"]["loopiter_capture"])},
        }

    async def complete_execution(self, _key, *, expected_revision, **kwargs):
        self.completes.append(kwargs["metadata"]["loopiter_capture"]["status"])
        return {"id": _key, "revision": expected_revision + 1}


class CaptureTests(unittest.IsolatedAsyncioTestCase):
    def loop(self):
        return FeedbackLoop(store=InMemoryStore(), namespace="capture")

    async def test_queue_limit_pairs_record_and_complete(self):
        with self.assertRaisesRegex(TypeError, "at least 2"):
            create_observer(self.loop(), bounded={"queue_limit": 1, "write_timeout_ms": 50})
        with self.assertRaisesRegex(TypeError, "cannot be combined"):
            create_observer(
                self.loop(),
                failure_mode="closed",
                bounded={"queue_limit": 2, "write_timeout_ms": 50},
            )
        stall = _Stall()
        notes = []
        tight = create_observer(
            stall,
            on_error=notes.append,
            bounded={"queue_limit": 2, "write_timeout_ms": 60},
        )
        self.assertEqual(await tight.observe("first", lambda: 1), 1)
        await asyncio.sleep(0.01)
        self.assertEqual(await tight.observe("second", lambda: 2), 2)
        self.assertEqual(tight.stats()["dropped"], 1)
        self.assertEqual(stall.calls, 1)
        self.assertEqual(len(notes), 1)
        await tight.shutdown(20)

    async def test_stalled_store_returns_and_shutdown_counts_the_drop(self):
        stall = _Stall()
        notes = []
        observer = create_observer(
            stall,
            on_error=notes.append,
            bounded={"queue_limit": 4, "write_timeout_ms": 60, "shutdown_timeout_ms": 1000},
        )
        started = asyncio.get_running_loop().time()
        self.assertEqual(await observer.observe("slow", lambda: "served"), "served")
        self.assertLess(asyncio.get_running_loop().time() - started, 0.05)
        await observer.shutdown(30)
        self.assertGreaterEqual(observer.stats()["dropped"], 1)
        self.assertTrue(notes)

    async def test_default_observe_still_awaits_the_store(self):
        loop = self.loop()
        gate = asyncio.Event()
        started = asyncio.Event()
        original = loop.record_execution

        async def gated(**kwargs):
            started.set()
            await gate.wait()
            return await original(**kwargs)

        loop.record_execution = gated
        observer = create_observer(loop)
        running = asyncio.create_task(
            observer.observe("wait", lambda: "ok", context={"id": "waited"})
        )
        await started.wait()
        self.assertFalse(running.done())
        gate.set()
        self.assertEqual(await running, "ok")
        row = await loop.get_execution("waited")
        self.assertEqual(row["metadata"]["loopiter_capture"]["status"], "completed")
        self.assertFalse(row["metadata"]["loopiter_capture"]["replay_eligible"])

    async def test_write_timeout_holds_the_slot_and_closes_the_late_row(self):
        stall = _Stall()
        timed = create_observer(stall, bounded={"queue_limit": 2, "write_timeout_ms": 30})
        self.assertEqual(await timed.observe("late", lambda: "served"), "served")
        await asyncio.sleep(0.05)
        self.assertEqual(timed.stats()["failed"], 1)
        self.assertEqual(stall.calls, 1)
        self.assertGreaterEqual(timed.stats()["backlog"], 1)
        self.assertEqual(await timed.observe("next", lambda: "nope"), "nope")
        self.assertEqual(stall.calls, 1)
        self.assertEqual(timed.stats()["dropped"], 1)
        stall.release.set_result(None)
        await timed.force_flush(200)
        self.assertEqual(stall.completes, ["failed"])
        await timed.shutdown(20)

    async def test_shutdown_drains_without_a_prior_flush(self):
        loop = self.loop()
        observer = create_observer(
            loop, bounded={"queue_limit": 4, "write_timeout_ms": 500, "shutdown_timeout_ms": 200}
        )
        self.assertEqual(
            await observer.observe("saved", lambda: "ok", context={"id": "shutdown-row"}), "ok"
        )
        await observer.shutdown()
        row = await loop.get_execution("shutdown-row")
        self.assertEqual(row["metadata"]["loopiter_capture"]["status"], "completed")
        self.assertEqual(observer.stats()["dropped"], 0)
        self.assertEqual(observer.stats()["failed"], 0)

    async def test_open_flush_does_not_abandon_and_repeated_flushes_stay_bounded(self):
        loop = self.loop()
        release = asyncio.Event()
        observer = create_observer(
            loop, bounded={"queue_limit": 4, "write_timeout_ms": 500, "shutdown_timeout_ms": 40}
        )
        running = asyncio.create_task(
            observer.observe(
                "held",
                lambda: _wait(release),
                context={"id": "held-row"},
            )
        )
        await asyncio.sleep(0.02)
        dropped = observer.stats()["dropped"]
        await observer.force_flush(30)
        self.assertEqual(observer.stats()["dropped"], dropped)
        self.assertGreaterEqual(observer.stats()["backlog"], 1)
        release.set()
        self.assertEqual(await running, "later")
        await observer.force_flush(200)
        row = await loop.get_execution("held-row")
        self.assertEqual(row["metadata"]["loopiter_capture"]["status"], "completed")

        stall = _Stall()
        repeated = create_observer(
            stall, bounded={"queue_limit": 4, "write_timeout_ms": 5000, "shutdown_timeout_ms": 15}
        )
        await repeated.observe("once", lambda: True)
        for _ in range(5):
            await repeated.force_flush(15)
        self.assertEqual(stall.calls, 1)
        await repeated.shutdown(15)

    async def test_overlapping_flush_does_not_cut_the_shutdown_drain(self):
        loop = self.loop()
        release = asyncio.Event()
        observer = create_observer(
            loop, bounded={"queue_limit": 4, "write_timeout_ms": 500, "shutdown_timeout_ms": 40}
        )
        running = asyncio.create_task(
            observer.observe("overlap", lambda: _wait(release), context={"id": "overlap-row"})
        )
        await asyncio.sleep(0.03)
        short = asyncio.create_task(observer.force_flush(80))
        drained = asyncio.create_task(observer.shutdown(800))
        await asyncio.sleep(0.15)
        release.set()
        self.assertEqual(await running, "later")
        await short
        await drained
        row = await loop.get_execution("overlap-row")
        self.assertEqual(row["metadata"]["loopiter_capture"]["status"], "completed")
        self.assertEqual(observer.stats()["dropped"], 0)

    async def test_shutdown_counts_a_running_operation_and_an_unconsumed_stream(self):
        loop = self.loop()
        notes = []
        observer = create_observer(
            loop,
            on_error=notes.append,
            bounded={"queue_limit": 10, "write_timeout_ms": 100, "shutdown_timeout_ms": 40},
        )
        release = asyncio.Event()
        running = asyncio.create_task(
            observer.observe("long", lambda: _wait(release), context={"id": "s1"})
        )
        await asyncio.sleep(0.02)
        await observer.shutdown(40)
        self.assertEqual(observer.stats(), {"dropped": 1, "failed": 0, "backlog": 0})
        self.assertEqual(len(notes), 1)
        release.set()
        self.assertEqual(await running, "later")
        await asyncio.sleep(0.03)
        self.assertEqual(observer.stats()["dropped"], 1)
        self.assertEqual(len(notes), 1)
        row = await loop.get_execution("s1")
        self.assertEqual(row["metadata"]["loopiter_capture"]["status"], "pending")

        stream_notes = []
        streaming = create_observer(
            loop,
            on_error=stream_notes.append,
            bounded={"queue_limit": 10, "write_timeout_ms": 100, "shutdown_timeout_ms": 40},
        )

        async def pending():
            yield 1

        wrapped = await streaming.observe("stream", pending, context={"id": "s3"})
        await asyncio.sleep(0.02)
        await streaming.shutdown(40)
        self.assertEqual(streaming.stats(), {"dropped": 1, "failed": 0, "backlog": 0})
        self.assertEqual(len(stream_notes), 1)
        async for _chunk in wrapped:
            pass
        await asyncio.sleep(0.03)
        self.assertEqual(streaming.stats()["dropped"], 1)
        self.assertEqual(len(stream_notes), 1)
        streamed = await loop.get_execution("s3")
        self.assertEqual(streamed["metadata"]["loopiter_capture"]["status"], "pending")

    async def test_shutdown_ignores_a_hung_record(self):
        stall = _Stall()
        observer = create_observer(
            stall, bounded={"queue_limit": 4, "write_timeout_ms": 5000, "shutdown_timeout_ms": 30}
        )
        running = asyncio.create_task(observer.observe("mid", lambda: "ran"))
        await asyncio.sleep(0.02)
        await observer.shutdown()
        stall.release.set_result(None)
        self.assertEqual(await running, "ran")
        await asyncio.sleep(0.03)
        self.assertEqual(stall.completes, [])

    async def test_durable_id_is_not_replayed(self):
        loop = self.loop()
        await loop.record_execution(id="kept", kind="workflow", input={"marker": "original"})
        before = await loop.get_execution("kept")
        ran = 0

        def operation():
            nonlocal ran
            ran += 1
            return 3

        observer = create_observer(loop, bounded={"queue_limit": 4, "write_timeout_ms": 200})
        self.assertEqual(await observer.observe("again", operation, context={"id": "kept"}), 3)
        self.assertEqual(ran, 1)
        await observer.force_flush(200)
        self.assertEqual(observer.stats()["failed"], 1)
        after = await loop.get_execution("kept")
        self.assertEqual(after["revision"], before["revision"])
        await observer.shutdown(20)

    def test_redaction_matches_the_node_capture_fixture(self):
        raw = {
            "authorization": "Bearer top-secret",
            "messages": [
                {
                    "content": "password=private https://alice:password@example.test sk-1234567890123456"
                }
            ],
            "apiKey": "private",
            "text": "safe",
        }
        redacted = capture_payload(raw, {"mode": "redacted"})
        self.assertNotRegex(
            json.dumps(redacted["value"]), "top-secret|private|alice|1234567890123456"
        )
        self.assertEqual(raw["apiKey"], "private")
        self.assertFalse(redacted["complete"])
        long = capture_payload(
            {"apiKey": "secret" * 2000}, {"mode": "redacted", "maximumBytes": 128}
        )
        self.assertFalse(long["truncated"])
        omitted = capture_payload({"text": "x" * 1000}, {"mode": "redacted", "maximumBytes": 128})
        self.assertEqual(omitted["value"], {"omitted": True, "truncated": True, "bytes": 1011})
        self.assertEqual(
            capture_payload(raw, {"mode": "metadata-only"})["value"], {"omitted": True}
        )
        self.assertTrue(capture_payload(raw, {"mode": "full"})["complete"])
        with self.assertRaises(TypeError):
            capture_payload(raw, {"mode": "redacted", "maximumBytes": True})

    async def test_import_dedupes_and_keeps_unknown_usage_off_the_release(self):
        loop = self.loop()
        ticket = _record("ticket-100", "classify", "support-ticket-v1")
        invoice = _record("invoice-200", "billing", "invoice-v1")
        listing = _record("listing-300", "catalog", "product-listing-v1")
        first = await import_batch(loop, [ticket, invoice, listing])
        self.assertEqual(first, {"accepted": 3, "conflicts": 0, "rejected": 0})
        self.assertEqual(await import_batch(loop, [ticket, invoice, listing]), first)
        historical = (await loop.list("historical"))["items"]
        self.assertEqual(len(historical), 3)
        self.assertEqual((await loop.list("executions"))["items"], [])
        self.assertEqual((await loop.list("targets"))["items"], [])
        imported = next(row for row in historical if row["id"] == "ticket-100")
        self.assertEqual(imported["created_at"], WHEN)
        self.assertEqual(imported["original"]["occurredAt"], WHEN)
        self.assertEqual(imported["original"]["usage"], {"state": "unknown"})
        self.assertNotIn("config", imported["original"]["versions"])
        self.assertNotIn("releaseId", imported["original"])
        changed = dict(ticket, status="error")
        self.assertEqual((await import_batch(loop, [changed]))["conflicts"], 1)
        again = next(
            row for row in (await loop.list("historical"))["items"] if row["id"] == "ticket-100"
        )
        self.assertEqual(again["original"]["status"], "success")
        dropped = await import_batch(
            loop,
            [
                _record("ticket-drop", "classify", "support-ticket-v1", status="dropped"),
                _record(
                    "invoice-zero",
                    "billing",
                    "invoice-v1",
                    usage={"state": "unknown", "tokens": 0},
                ),
                {**listing, "releaseId": "current"},
            ],
        )
        self.assertEqual(dropped, {"accepted": 1, "conflicts": 0, "rejected": 2})
        tombstone = next(
            row for row in (await loop.list("historical"))["items"] if row["id"] == "ticket-drop"
        )
        self.assertEqual(tombstone["original"]["status"], "dropped")
        self.assertEqual((await loop.list("executions"))["items"], [])
        known = await import_batch(
            loop,
            [
                _record(
                    "invoice-known", "billing", "invoice-v1", usage={"state": "known", "tokens": 4}
                )
            ],
        )
        self.assertEqual(known["accepted"], 1)
        shared = _record(
            "ticket-ms", "classify", "support-ticket-v1", occurredAt="2026-03-01T15:04:05.123Z"
        )
        self.assertEqual((await import_batch(loop, [shared]))["accepted"], 1)
        micros = _record(
            "ticket-us", "classify", "support-ticket-v1", occurredAt="2026-03-01T15:04:05.123456Z"
        )
        self.assertEqual((await import_batch(loop, [micros]))["rejected"], 1)
        calendar = _record(
            "ticket-day", "classify", "support-ticket-v1", occurredAt="2026-02-31T00:00:00Z"
        )
        self.assertEqual((await import_batch(loop, [calendar]))["rejected"], 1)


async def _wait(event):
    await event.wait()
    return "later"


if __name__ == "__main__":
    unittest.main()
