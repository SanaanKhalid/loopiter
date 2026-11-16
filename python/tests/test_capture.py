import asyncio
import json
import time
import unittest

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError
from loopiter.integrations.import_batch import import_batch
from loopiter.integrations.observe import create_observer
from loopiter.integrations.privacy import (
    _redact_cards,
    _redact_text,
    capture_payload,
    redact_capture,
)

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

    def test_seeded_card_fuzz_does_not_undercount(self):
        layouts = (
            (4, 4, 4, 4, 3),
            (4, 4, 4, 4),
            (4, 6, 5),
            (4, 6, 4),
            (4, 4, 5),
            (4, 4, 4, 3),
            (4, 4, 6),
            (8, 8),
            (4, 4, 8),
            (4, 12),
        )
        exact = set(layouts)
        prefixes = {layout[:size] for layout in layouts for size in range(1, len(layout) + 1)}

        def digit(ch):
            return "0" <= ch <= "9"

        def luhn(digits):
            total = 0
            alt = False
            for n in reversed(digits):
                if alt:
                    n *= 2
                    if n > 9:
                        n -= 9
                total += n
                alt = not alt
            return total % 10 == 0

        def reference(value):
            """Allowed card layouts only, longest Luhn match, then the next group."""
            i = 0
            count = 0
            n = len(value)
            while i < n:
                if not digit(value[i]):
                    i += 1
                    continue
                starts = []
                ends = []
                seps = []
                glens = []
                digits = []
                while i < n and digit(value[i]):
                    starts.append(i)
                    glen = 0
                    while i < n and digit(value[i]):
                        digits.append(ord(value[i]) - 48)
                        glen += 1
                        i += 1
                    ends.append(i)
                    glens.append(glen)
                    if i + 1 < n and value[i] in " -" and digit(value[i + 1]):
                        seps.append(value[i])
                        i += 1
                        continue
                    seps.append("")
                    break
                offset = [0]
                for glen in glens:
                    offset.append(offset[-1] + glen)
                group = 0
                groups = len(glens)
                while group < groups:
                    start_at = starts[group]
                    if start_at and digit(value[start_at - 1]):
                        group += 1
                        continue
                    glen = glens[group]
                    if 13 <= glen <= 19 and luhn(digits[offset[group] : offset[group + 1]]):
                        end_at = ends[group]
                        if end_at == n or not digit(value[end_at]):
                            count += 1
                            group += 1
                            continue
                    sep = seps[group]
                    if not sep or glen not in (4, 8):
                        group += 1
                        continue
                    lengths = [glen]
                    look = group + 1
                    while look < groups and seps[look - 1] == sep:
                        nxt = tuple(lengths + [glens[look]])
                        if nxt not in prefixes:
                            break
                        lengths.append(glens[look])
                        look += 1
                    matched = 0
                    for size in range(len(lengths), 0, -1):
                        if tuple(lengths[:size]) not in exact:
                            continue
                        end_group = group + size
                        end_at = ends[end_group - 1]
                        if not luhn(digits[offset[group] : offset[end_group]]):
                            continue
                        if end_at != n and digit(value[end_at]):
                            continue
                        matched = end_group
                        break
                    if matched == 0:
                        group += 1
                        continue
                    count += 1
                    group = matched
            return count

        state = 42

        def rnd():
            nonlocal state
            state = (1664525 * state + 1013904223) & 0xFFFFFFFF
            return state / 4294967296

        alphabet = "0123456789 -"
        redacted = 0
        baseline = 0
        for _ in range(200):
            length = 24 + int(rnd() * 40)
            sample = "".join(alphabet[int(rnd() * len(alphabet))] for _k in range(length))
            if rnd() < 0.3:
                sample += (" " if rnd() < 0.5 else "-") + "4111111111111111"
            once = redact_capture(sample)
            # This alphabet stays idempotent. A second pass is not guaranteed for arbitrary text.
            self.assertEqual(redact_capture(once), once)
            redacted += once.count("[REDACTED]")
            baseline += reference(sample)
        self.assertGreaterEqual(redacted, baseline)
        self.assertEqual(redacted, baseline)
        self.assertEqual(redacted, 81)

        def elapsed(sample: str) -> float:
            started_at = time.perf_counter()
            _redact_cards(sample)
            return time.perf_counter() - started_at

        def scales(sample: str) -> None:
            small = elapsed(sample)
            large = elapsed(sample * 4)
            self.assertLess(large, max(small * 6, 0.05))
            self.assertLess(large, 8)
            self.assertLess(small, 0.05)

        scales("1 " * 32768)
        scales("7 " * 32768)
        scales("12 " * 21845)
        scales("4111 " * 13107)
        scales("4111-" * 13107)
        scales("4 " * 32768)

        def elapsed_text(sample: str) -> float:
            started_at = time.perf_counter()
            _redact_text(sample)
            return time.perf_counter() - started_at

        def scales_text(sample: str) -> None:
            small = elapsed_text(sample)
            large = elapsed_text(sample * 4)
            self.assertLess(large, max(small * 6, 0.05))
            self.assertLess(large, 8)
            self.assertLess(small, 0.05)

        scales_text("4111111111111111 " * 3855)
        scales_text("a@b.cd " * 9362)
        scales_text("Bearer 1 " * 7282)
        scales_text("sk-abcdefghijklmnop " * 3276)
        scales_text("eyJa.b.c " * 7281)
        scales_text("Basic 4111 " * 5957)
        scales_text("http://u:p@a.co " * 4096)
        scales_text("https://u:p@h.io/ " * 3640)
        scales_text("4111111111111111sk-abcdefghijklmnop" * 1872)
        scales_text(
            "4111111111111111eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl" * 910
        )
        scales_text("4111111111111111eyJ" * 3449)
        scales_text("4111111111111111sk-" * 3449)

    def test_glued_secret_fuzz_stays_idempotent(self):
        pieces = (
            "AKIAABCDEFGHIJKLMNOP",
            "AKIA1234567890123456",
            "4111111111111111",
            "3782 822463 10005",
            "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl",
            "user@example.com",
            "a@b.cd",
            "sk-abcdefghijklmnop",
            "Bearer secretvalue",
            "Basic dXNlcjpwYXNz",
        )
        state = 42

        def rnd():
            nonlocal state
            state = (1664525 * state + 1013904223) & 0xFFFFFFFF
            return state / 4294967296

        exceptions = 0
        for _ in range(200):
            sample = "".join(
                pieces[int(rnd() * len(pieces))] for _part in range(1 + int(rnd() * 4))
            )
            once = redact_capture(sample)
            if redact_capture(once) != once:
                exceptions += 1
        # This glued alphabet is idempotent. Arbitrary text is not.
        self.assertEqual(exceptions, 0)

    def test_glued_email_secrets_stay_hidden(self):
        emails = ("user@example.com", "alice@example.com", "a@b.io", "a@b.cd")
        jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.abcDEF123"
        sk = "sk-abcdefghijklmnop"
        digits = ("9", "555", "1", "2", "0")
        prefixes = ("", "mail ", "contact: ")
        suffixes = ("", " now", " and bob")
        state = 42

        def nxt() -> int:
            nonlocal state
            state = (1664525 * state + 1013904223) & 0xFFFFFFFF
            return state

        for _ in range(200):
            email = emails[nxt() % len(emails)]
            prefix = prefixes[nxt() % len(prefixes)]
            kind = nxt() % 3
            if kind == 0:
                trailer = digits[nxt() % len(digits)]
                secrets = (email,)
            elif kind == 1:
                trailer = jwt
                secrets = (email, "eyJhbGciOiJub25lIn0", "eyJzdWIiOiJ4In0")
            else:
                trailer = sk
                secrets = (email, sk)
            sample = prefix + email + trailer + suffixes[nxt() % len(suffixes)]
            redacted = redact_capture(sample)
            for secret in secrets:
                self.assertNotIn(secret, redacted)

    def test_redaction_covers_the_recorded_baseline(self):
        from pathlib import Path

        # Outputs recorded at 070f524. A later pass may cover more, but it must
        # not show text that revision already replaced.
        rows = json.loads(
            (
                Path(__file__).resolve().parents[2] / "test/fixtures/redaction-baseline.json"
            ).read_text(encoding="utf-8")
        )
        for row in rows:
            current = redact_capture(row["input"])
            if row["exact"]:
                self.assertEqual(current, row["baseline"])
            visible = row["baseline"].split("[REDACTED]")
            for piece in current.split("[REDACTED]"):
                if piece:
                    self.assertTrue(any(piece in part for part in visible), row["input"])

    def test_detectors_read_the_original_text_only(self):
        from unittest.mock import patch

        import loopiter.integrations.privacy as privacy

        sample = "Bearer sk-abcdefghijklmnop.SECRETTAIL"
        seen: list[str] = []

        class _Spy:
            def __init__(self, pattern):
                self.pattern = pattern

            def finditer(self, text, *args, **kwargs):
                seen.append(text)
                return self.pattern.finditer(text, *args, **kwargs)

            def sub(self, repl, text, *args, **kwargs):
                seen.append(text)
                return self.pattern.sub(repl, text, *args, **kwargs)

        def wrap(name):
            func = getattr(privacy, name)

            def inner(value, *args, **kwargs):
                seen.append(value)
                return func(value, *args, **kwargs)

            return inner

        names = (
            "_PRIVATE_KEY",
            "_TOKEN",
            "_AWS_SECRET",
            "_BEARER",
            "_BASIC",
            "_ASSIGNED_SECRET",
            "_QUERY_TOKEN",
        )
        with (
            patch.multiple(privacy, **{name: _Spy(getattr(privacy, name)) for name in names}),
            patch.object(privacy, "_card_spans", wrap("_card_spans")),
            patch.object(privacy, "_url_spans", wrap("_url_spans")),
            patch.object(privacy, "_email_spans", wrap("_email_spans")),
        ):
            privacy._redact_text(sample)
        self.assertGreater(len(seen), 0)
        self.assertTrue(all(text == sample for text in seen))

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
