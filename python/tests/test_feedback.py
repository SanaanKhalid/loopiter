import json
import math
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError, served_answer_id
from loopiter._validation import fail
from loopiter.feedback import (
    feedback_cursor_id,
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


if __name__ == "__main__":
    unittest.main()
