import asyncio
import json
import time
import unittest

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError
from loopiter.integrations.import_batch import import_batch
from loopiter.integrations.observe import create_observer
from loopiter.integrations.privacy import capture_payload, redact_capture

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

    def test_redaction_matches_the_shared_fixture(self):
        from collections import OrderedDict, defaultdict
        from pathlib import Path

        parity = json.loads(
            (Path(__file__).resolve().parents[2] / "test/fixtures/redaction-parity.json").read_text(
                encoding="utf-8"
            )
        )
        raw = json.loads(json.dumps(parity["sensitive"]["input"]))
        redacted = capture_payload(raw, {"mode": "redacted"})
        self.assertEqual(redacted["value"], parity["sensitive"]["output"])
        self.assertEqual(raw["apiKey"], parity["sensitive"]["input"]["apiKey"])
        self.assertFalse(redacted["complete"])
        for item in parity["whitespace"]:
            self.assertEqual(redact_capture(item["input"]), item["output"])
        for item in parity["boundaries"]:
            self.assertEqual(redact_capture(item["input"]), item["output"])
        repeat = parity["credentialRepeat"]
        long = capture_payload(
            {repeat["key"]: repeat["unit"] * repeat["count"]},
            {"mode": "redacted", "maximumBytes": repeat["maximumBytes"]},
        )
        self.assertFalse(long["truncated"])
        oversized = parity["oversized"]
        omitted = capture_payload(
            {oversized["key"]: oversized["unit"] * oversized["count"]},
            {"mode": "redacted", "maximumBytes": oversized["maximumBytes"]},
        )
        self.assertEqual(
            omitted["value"], {"omitted": True, "truncated": True, "bytes": oversized["bytes"]}
        )

        class Marker(str):
            pass

        self.assertNotIn(
            "fixture-marker-alpha", str(redact_capture(Marker("Bearer fixture-marker-alpha")))
        )
        self.assertNotIn(
            "fixture-marker-alpha", redact_capture(("Bearer fixture-marker-alpha",))[0]
        )
        ordered = OrderedDict([("token", "fixture-marker-kappa"), ("text", "kept-label")])
        walked = redact_capture(ordered)
        self.assertIsInstance(walked, OrderedDict)
        self.assertEqual(walked["token"], "[REDACTED]")
        grouped = defaultdict(str, {"apiKey": "fixture-marker-delta"})
        self.assertEqual(redact_capture(grouped)["apiKey"], "[REDACTED]")
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
        claimed = _record(
            "ticket-replay",
            "classify",
            "support-ticket-v1",
            replay={"eligible": True, "reason": "imported-for-regression"},
        )
        self.assertEqual((await import_batch(loop, [claimed]))["rejected"], 1)
        plain = _record("ticket-plain", "classify", "support-ticket-v1")
        self.assertEqual((await import_batch(loop, [plain]))["accepted"], 1)
        stored = next(
            row for row in (await loop.list("historical"))["items"] if row["id"] == "ticket-plain"
        )
        self.assertEqual(stored["original"]["replay"], {"eligible": False})
        with self.assertRaises(LoopiterError):
            await import_batch(loop, [plain, plain], max_records=1)
        lengthy = _record("ticket-long", "classify", "x" * 5000)
        self.assertEqual((await import_batch(loop, [lengthy], max_string_length=64))["rejected"], 1)
        emoji = _record("😀" * 24, "c", "p")
        self.assertEqual((await import_batch(loop, [emoji], max_string_length=24))["accepted"], 1)
        deeper = _record("deep-ok", "classify", "support-ticket-v1")
        too_deep = _record("deep-bad", "classify", "support-ticket-v1")
        nested: object = "leaf"
        for _ in range(40):
            nested = {"child": nested}
        too_deep["versions"] = nested
        mixed = await import_batch(
            loop,
            [deeper, too_deep, _record("deep-after", "classify", "support-ticket-v1")],
        )
        self.assertEqual(mixed, {"accepted": 2, "conflicts": 0, "rejected": 1})
        ids = [row["id"] for row in (await loop.list("historical"))["items"]]
        self.assertIn("deep-ok", ids)
        self.assertIn("deep-after", ids)
        self.assertNotIn("deep-bad", ids)

    def test_redaction_stays_inside_a_generous_time_bound(self):
        self.assertEqual(
            redact_capture("eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl"),
            "[REDACTED]",
        )
        self.assertEqual(redact_capture("9000000000001"), "[REDACTED]")
        self.assertEqual(redact_capture("9000000000000000001"), "[REDACTED]")
        self.assertEqual(redact_capture("1234567890123456"), "1234567890123456")
        bulky = "eyJ-" * 262144 + "9" * 262144 + "http://user:" + "a" * 262144
        bulky += " secret_access_key=" + "A" * 39 + " a@"
        spaced = "4 " * 32768
        dashed = "4111-" * 8192
        started = time.perf_counter()
        redact_capture(bulky)
        redact_capture(spaced)
        redact_capture(dashed)
        self.assertLess(time.perf_counter() - started, 2)
        capped = time.perf_counter()
        omitted = capture_payload(bulky, {"mode": "redacted"})
        self.assertLess(time.perf_counter() - capped, 2)
        self.assertTrue(omitted["value"]["omitted"])

    async def test_bounded_open_map_is_cleared(self):
        loop = self.loop()
        client = create_observer(loop, bounded={"queue_limit": 2, "write_timeout_ms": 50})
        bounded = client._bounded
        assert bounded is not None
        first = await client.record_execution(id="held", kind="inference", input={"secret": "x"})
        self.assertIsNotNone(first)
        dropped = await client.record_execution(
            id="dropped", kind="inference", input={"secret": "y"}
        )
        self.assertIsNone(dropped)
        self.assertNotIn("dropped", bounded._open)
        reused = await client.record_execution(id="held", kind="inference", input={"secret": "z"})
        self.assertIsNone(reused)
        self.assertEqual(bounded.reserved, 1)
        self.assertEqual(list(bounded._open), ["held"])
        await client.shutdown(20)
        self.assertEqual(bounded._open, {})

        delayed = self.loop()
        original = delayed.record_execution

        async def slow_write(**kwargs):
            await asyncio.sleep(0.08)
            return await original(**kwargs)

        delayed.record_execution = slow_write
        slow = create_observer(
            delayed, bounded={"queue_limit": 4, "write_timeout_ms": 30, "shutdown_timeout_ms": 40}
        )
        assert slow._bounded is not None
        opened = await slow.record_execution(id="slow", kind="inference", input={"secret": "slow"})
        self.assertIsNotNone(opened)
        await asyncio.sleep(0.05)
        await slow.complete_execution("slow", expected_revision=1, output={"done": True})
        self.assertEqual(slow._bounded._open, {})
        await slow.shutdown(40)
        self.assertEqual(slow._bounded._open, {})


async def _wait(event):
    await event.wait()
    return "later"


if __name__ == "__main__":
    unittest.main()
