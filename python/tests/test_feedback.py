import json
import math
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from test_core import Registry, approved

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError, served_answer_id
from loopiter._validation import fail
from loopiter.feedback import (
    feedback_cursor_id,
    feedback_head_id,
    feedback_input,
    feedback_record_id,
    persist_feedback,
    promote_feedback_cursor,
    read_feedback_head,
    rewind_promoted_cursor,
    target_scope,
)
from loopiter.run_caps import admit_model_call, cap_block

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "test" / "fixtures" / "served-answer.json").read_text()
)
NOW = "2026-01-15T12:00:00.000Z"
TARGET = {"kind": "prompt", "key": "classifier"}


class FeedbackTests(unittest.IsolatedAsyncioTestCase):
    def test_served_answer_ids_match_the_shared_fixture(self):
        for item in FIXTURE["cases"]:
            self.assertEqual(served_answer_id(item["input"]), item["id"])
        self.assertNotEqual(FIXTURE["cases"][0]["id"], FIXTURE["cases"][1]["id"])
        self.assertNotEqual(FIXTURE["cases"][2]["id"], FIXTURE["cases"][3]["id"])
        for item in FIXTURE["feedback"]:
            self.assertEqual(feedback_record_id(feedback_input(item["input"])), item["id"])

    def test_validation_fails_closed(self):
        with self.assertRaises(LoopiterError) as error:
            served_answer_id({"namespace": "app", "answer": "ok", "extra": 1})
        self.assertEqual(error.exception.code, "invalid_input")
        with self.assertRaises(LoopiterError):
            served_answer_id({"namespace": "app", "answer": "bad\ntext"})
        with self.assertRaises(LoopiterError):
            served_answer_id({"namespace": "app", "answer": "\u0085"})
        with self.assertRaises(LoopiterError):
            feedback_input({"answerId": "ans_x", "target": TARGET})
        with self.assertRaises(LoopiterError):
            feedback_input({"answerId": "ans_x", "target": TARGET, "edit": "fix\u0007"})
        self.assertEqual(
            feedback_input(
                {
                    "answerId": "ans_x",
                    "target": TARGET,
                    "rating": {"kind": "thumbs", "value": "up"},
                }
            ),
            {
                "answerId": "ans_x",
                "target": TARGET,
                "rating": {"kind": "thumbs", "value": "up"},
            },
        )

    def test_text_length_counts_code_points(self):
        for item in FIXTURE["text"]:
            if "unit" in item:
                accepted = item["unit"] * item["accept"]
                rejected = item["unit"] * item["reject"]
                self.assertEqual(len(accepted), item["accept"])
                feedback_input(
                    {
                        "answerId": "ans_x",
                        "target": TARGET,
                        "rating": {"kind": "thumbs", "value": "up"},
                        "note": accepted,
                    }
                )
                with self.assertRaises(LoopiterError) as error:
                    feedback_input(
                        {
                            "answerId": "ans_x",
                            "target": TARGET,
                            "rating": {"kind": "thumbs", "value": "up"},
                            "note": rejected,
                        }
                    )
                self.assertEqual(error.exception.code, "invalid_input")
            if "text" in item:
                with self.assertRaises(LoopiterError) as error:
                    feedback_input(
                        {
                            "answerId": "ans_x",
                            "target": TARGET,
                            "rating": {"kind": "thumbs", "value": "up"},
                            "note": item["text"],
                        }
                    )
                self.assertEqual(error.exception.code, "invalid_input")

    async def test_feedback_cursor_advance_rewind_and_crash(self):
        store = InMemoryStore()
        loop = FeedbackLoop(store=store, namespace="app", clock=lambda: NOW)
        scope = target_scope(TARGET)
        answer_id = served_answer_id({"namespace": "app", "answer": "The invoice is paid."})
        body = {
            "answerId": answer_id,
            "target": TARGET,
            "rating": {"kind": "numeric", "value": 0.2},
            "edit": "The invoice is unpaid.",
            "note": "reviewer",
        }
        first = await loop.record_feedback(**body)
        again = await loop.record_feedback(**body)
        self.assertEqual(again["id"], first["id"])
        async with store.transaction("app") as tx:
            seen = await read_feedback_head(tx, scope)
            promoted = await promote_feedback_cursor(tx, "app", NOW, scope, "run_1", seen)
            row = await tx.get("coordination", feedback_cursor_id(scope))
        self.assertEqual(promoted["position"], first["id"])
        self.assertIsNone(promoted["previous"])
        self.assertEqual(row["revision"], 1)
        async with store.transaction("app") as tx:
            repeat = await promote_feedback_cursor(tx, "app", NOW, scope, "run_1", seen)
        self.assertEqual(repeat, promoted)
        later = await loop.record_feedback(
            answerId=answer_id, target=TARGET, edit="after the run started"
        )
        async with store.transaction("app") as tx:
            held = await promote_feedback_cursor(tx, "app", NOW, scope, "run_2", seen)
        self.assertEqual(held["position"], first["id"])
        self.assertNotEqual(held["position"], later["id"])
        other = target_scope({"kind": "prompt", "key": "other"})
        async with store.transaction("app") as tx:
            isolated = await tx.get("coordination", feedback_cursor_id(other))
            await tx.insert(
                "runs",
                {
                    "id": "run_2",
                    "namespace": "app",
                    "revision": 1,
                    "created_at": NOW,
                    "updated_at": NOW,
                    "format": 1,
                    "data": {"selected_id": "cand-2"},
                },
            )
        self.assertIsNone(isolated)
        async with store.transaction("app") as tx:
            rewound = await rewind_promoted_cursor(
                tx, "app", NOW, {"id": "cand-2", "target": TARGET}
            )
        self.assertEqual(rewound["position"], first["id"])
        self.assertIsNone(rewound["promotion_id"])
        async with store.transaction("app") as tx:
            ignored = await rewind_promoted_cursor(
                tx, "app", NOW, {"id": "other", "target": TARGET}
            )
        self.assertEqual(ignored["position"], first["id"])

        with self.assertRaises(LoopiterError):
            async with store.transaction("app") as tx:
                await persist_feedback(
                    tx,
                    "app",
                    NOW,
                    feedback_input(
                        {"answerId": answer_id, "target": TARGET, "edit": "replacement"}
                    ),
                )
                seen = await read_feedback_head(tx, scope)
                await promote_feedback_cursor(tx, "app", NOW, scope, "run_crash", seen)
                raise LoopiterError("callback_failed", "crash between steps")
        async with store.transaction("app") as tx:
            page = await tx.list("coordination", limit=100)
            cursor = await tx.get("coordination", feedback_cursor_id(scope))
        edits = [item["data"].get("edit") for item in page["items"]]
        self.assertNotIn("replacement", edits)
        self.assertIsNone(cursor["data"]["promotion_id"])

    async def test_malformed_cursor_fails_closed(self):
        scope = target_scope(TARGET)
        key = feedback_cursor_id(scope)

        async def plant(data):
            store = InMemoryStore()
            async with store.transaction("app") as tx:
                await tx.insert(
                    "coordination",
                    {
                        "id": key,
                        "namespace": "app",
                        "revision": 1,
                        "created_at": NOW,
                        "updated_at": NOW,
                        "format": 1,
                        "data": data,
                    },
                )
            with self.assertRaises(LoopiterError) as error:
                async with store.transaction("app") as tx:
                    await promote_feedback_cursor(
                        tx, "app", NOW, scope, "run_1", {"id": None, "recorded_at": None}
                    )
            self.assertEqual(error.exception.code, "invalid_state")

        await plant({"position": 42, "previous": {}, "promotion_id": 7})
        await plant(
            {
                "kind": "feedback-cursor",
                "position": None,
                "position_at": None,
                "previous": None,
                "previous_at": None,
                "promotion_id": None,
                "extra": True,
            }
        )

    async def test_caps_reset_on_utc_boundaries(self):
        store = InMemoryStore()
        caps = {"monthly_budget": 1, "call_cost": 1, "runs_per_day": 1}
        scope = target_scope(TARGET)
        january = "2026-01-31T23:59:59.000Z"
        february = "2026-02-01T00:00:00.000Z"
        async with store.transaction("app") as tx:
            await admit_model_call(tx, "app", caps, january, "propose:0", scope)
        async with store.transaction("app") as tx:
            self.assertEqual(
                await cap_block(tx, caps, january, "propose:0", scope), "daily_run_cap"
            )
            self.assertEqual(
                await cap_block(tx, caps, january, "validation:candidate_1", scope), "budget_cap"
            )
            self.assertIsNone(await cap_block(tx, caps, february, "propose:0", scope))
            await admit_model_call(tx, "app", caps, january, "observe:1", scope)
            runs = await tx.get("coordination", f"cap-runs:{scope}:2026-01-31")
            other = target_scope({"kind": "prompt", "key": "other"})
            self.assertIsNone(await cap_block(tx, caps, january, "propose:0", other))
        self.assertEqual(runs["data"]["count"], 1)

    async def test_corrupt_counters_fail_closed(self):
        caps = {"monthly_budget": 1, "call_cost": 1, "runs_per_day": 1}
        scope = target_scope(TARGET)

        class Fake:
            def __init__(self, spend, runs):
                self.spend = spend
                self.runs = runs

            async def get(self, _collection, key):
                if key.startswith("cap-runs:"):
                    return {"data": {"count": self.runs}}
                if key.startswith("cap-spend:"):
                    return {"data": {"amount": self.spend}}
                return None

        async def check(spend, runs):
            tx = Fake(spend, runs)
            with self.assertRaises(LoopiterError) as error:
                await cap_block(tx, caps, NOW, "propose:0", scope)
            self.assertEqual(error.exception.code, "invalid_state")
            with self.assertRaises(LoopiterError) as admitted:
                await admit_model_call(tx, "app", caps, NOW, "propose:0", scope)
            self.assertEqual(admitted.exception.code, "invalid_state")

        for spend in ("999", {}, -1, math.nan, math.inf, True, {"nested": 1}):
            await check(spend, 0)
        for runs in ("5", -1, 1.5, math.nan, True, {"nested": 1}):
            await check(0, runs)

        store = InMemoryStore()
        original = store.transaction

        @asynccontextmanager
        async def transaction(namespace):
            async with original(namespace) as tx:
                insert, replace = tx.insert, tx.replace

                async def wrapped_insert(collection, row):
                    if collection == "coordination" and str(row["id"]).startswith("cap-"):
                        fail("conflict", "injected")
                    return await insert(collection, row)

                async def wrapped_replace(collection, row, expected):
                    if collection == "coordination" and str(row["id"]).startswith("cap-"):
                        fail("conflict", "injected")
                    return await replace(collection, row, expected)

                tx.insert = wrapped_insert
                tx.replace = wrapped_replace
                yield tx

        store.transaction = transaction
        with self.assertRaises(LoopiterError) as error:
            async with store.transaction("app") as tx:
                await admit_model_call(tx, "app", caps, NOW, "propose:0", scope)
        self.assertEqual(error.exception.code, "cap_conflict")
        async with store.transaction("app") as tx:
            spent = await tx.get("coordination", f"cap-spend:{scope}:2026-01")
        self.assertIsNone(spent)

    async def test_malformed_cursor_does_not_block_rollback(self):
        store = InMemoryStore()
        loop = FeedbackLoop(store=store, namespace="app", clock=lambda: NOW)
        adapter = Registry()
        candidate = await approved(loop, "served")
        await loop.deploy_candidate(candidate["id"], adapter)
        chat = {"kind": "prompt", "key": "support"}
        scope = target_scope(chat)
        key = feedback_cursor_id(scope)
        malformed = {"position": 42, "previous": {}, "promotion_id": 7}
        async with store.transaction("app") as tx:
            await tx.insert(
                "coordination",
                {
                    "id": key,
                    "namespace": "app",
                    "revision": 1,
                    "created_at": NOW,
                    "updated_at": NOW,
                    "format": 1,
                    "data": malformed,
                },
            )
        await loop.rollback_candidate(candidate["id"], adapter)
        rolled = await loop.get_candidate(candidate["id"])
        self.assertEqual(rolled["status"], "rolled_back")
        self.assertIn("rollback_receipt", rolled)
        attempts = await loop.list("attempts", limit=100)
        self.assertTrue(attempts["items"])
        self.assertFalse(any(item["status"] == "pending" for item in attempts["items"]))
        targets = await loop.list("targets", limit=100)
        for row in targets["items"]:
            self.assertIsNone(row.get("pending_attempt_id"))
        async with store.transaction("app") as tx:
            cursor = await tx.get("coordination", key)
        self.assertEqual(cursor["revision"], 1)
        self.assertEqual(cursor["data"]["position"], 42)
        nxt = await approved(loop, "next")
        await loop.deploy_candidate(nxt["id"], adapter)
        self.assertEqual((await loop.get_candidate(nxt["id"]))["status"], "deployed")
        with self.assertRaises(LoopiterError) as error:
            async with store.transaction("app") as tx:
                await promote_feedback_cursor(
                    tx,
                    "app",
                    NOW,
                    scope,
                    "run_next",
                    {"id": "feedback:later", "recorded_at": NOW, "seq": 1},
                )
        self.assertEqual(error.exception.code, "invalid_state")
        async with store.transaction("app") as tx:
            still = await tx.get("coordination", key)
        self.assertEqual(still["revision"], 1)
        self.assertEqual(still["data"]["position"], 42)

    async def test_sequence_ignores_clock_order(self):
        store = InMemoryStore()
        now = {"value": NOW}

        def clock():
            return now["value"]

        loop = FeedbackLoop(store=store, namespace="app", clock=clock)
        scope = target_scope(TARGET)
        first = await loop.record_feedback(
            answerId="ans_a", target=TARGET, rating={"kind": "thumbs", "value": "down"}
        )
        async with store.transaction("app") as tx:
            seen = await read_feedback_head(tx, scope)
        self.assertEqual(seen["seq"], 1)
        later_id = ""
        later_seq = 0
        for index in range(40):
            saved = await loop.record_feedback(
                answerId="ans_a", target=TARGET, edit=f"same-ms-{index}"
            )
            async with store.transaction("app") as tx:
                row = await tx.get("coordination", saved["id"])
            if saved["id"] < first["id"]:
                later_id = saved["id"]
                later_seq = row["data"]["seq"]
                break
        self.assertLess(later_id, first["id"])
        self.assertGreater(later_seq, 1)
        async with store.transaction("app") as tx:
            promoted = await promote_feedback_cursor(tx, "app", NOW, scope, "run_1", seen)
        self.assertEqual(promoted["position"], first["id"])
        self.assertEqual(promoted["seq"], 1)
        self.assertGreater(later_seq, promoted["seq"])
        now["value"] = "2026-01-15T11:00:00.000Z"
        skewed = await loop.record_feedback(
            answerId="ans_a", target=TARGET, edit="clock went backwards"
        )
        async with store.transaction("app") as tx:
            skewed_row = await tx.get("coordination", skewed["id"])
            held = await promote_feedback_cursor(tx, "app", now["value"], scope, "run_2", seen)
        self.assertLess(skewed_row["data"]["recorded_at"], NOW)
        self.assertGreater(skewed_row["data"]["seq"], 1)
        self.assertEqual(held["seq"], 1)
        self.assertEqual(held["position"], first["id"])
        self.assertGreater(skewed_row["data"]["seq"], held["seq"])

    async def test_bad_sequence_fails_closed(self):
        scope = target_scope(TARGET)
        head = feedback_head_id(scope)
        for seq in ("3", -1, 1.5, True):
            store = InMemoryStore()
            async with store.transaction("app") as tx:
                await tx.insert(
                    "coordination",
                    {
                        "id": head,
                        "namespace": "app",
                        "revision": 1,
                        "created_at": NOW,
                        "updated_at": NOW,
                        "format": 1,
                        "data": {
                            "kind": "feedback-head",
                            "id": "feedback:old",
                            "recorded_at": NOW,
                            "seq": seq,
                        },
                    },
                )
            with self.assertRaises(LoopiterError) as error:
                async with store.transaction("app") as tx:
                    await read_feedback_head(tx, scope)
            self.assertEqual(error.exception.code, "invalid_state")

        class Fake:
            def __init__(self, seq):
                self.seq = seq

            async def get(self, _collection, _key):
                return {
                    "data": {
                        "kind": "feedback-head",
                        "id": "feedback:old",
                        "recorded_at": NOW,
                        "seq": self.seq,
                    }
                }

        for seq in (math.nan, math.inf):
            with self.assertRaises(LoopiterError) as error:
                await read_feedback_head(Fake(seq), scope)
            self.assertEqual(error.exception.code, "invalid_state")

        store = InMemoryStore()
        loop = FeedbackLoop(store=store, namespace="app", clock=lambda: NOW)
        saved = await loop.record_feedback(
            answerId="ans_a", target=TARGET, rating={"kind": "thumbs", "value": "up"}
        )
        async with store.transaction("app") as tx:
            row = await tx.get("coordination", saved["id"])
            await tx.replace(
                "coordination",
                {**row, "revision": row["revision"] + 1, "data": {**row["data"], "seq": "1"}},
                row["revision"],
            )
        with self.assertRaises(LoopiterError) as error:
            await loop.record_feedback(
                answerId="ans_a", target=TARGET, rating={"kind": "thumbs", "value": "up"}
            )
        self.assertEqual(error.exception.code, "invalid_state")


if __name__ == "__main__":
    unittest.main()
