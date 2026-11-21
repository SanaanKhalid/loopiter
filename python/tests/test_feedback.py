import json
import unittest
from pathlib import Path

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError, served_answer_id
from loopiter.feedback import apply_feedback_cursor, feedback_input, persist_feedback
from loopiter.run_caps import admit_model_call, cap_block

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "test" / "fixtures" / "served-answer.json").read_text()
)
NOW = "2026-01-15T12:00:00.000Z"


class FeedbackTests(unittest.IsolatedAsyncioTestCase):
    def test_served_answer_ids_match_the_shared_fixture(self):
        for item in FIXTURE["cases"]:
            self.assertEqual(served_answer_id(item["input"]), item["id"])
        self.assertNotEqual(FIXTURE["cases"][0]["id"], FIXTURE["cases"][1]["id"])

    def test_validation_fails_closed(self):
        with self.assertRaises(LoopiterError) as error:
            served_answer_id({"namespace": "app", "answer": "ok", "extra": 1})
        self.assertEqual(error.exception.code, "invalid_input")
        with self.assertRaises(LoopiterError):
            served_answer_id({"namespace": "app", "answer": "bad\ntext"})
        with self.assertRaises(LoopiterError):
            feedback_input({"answerId": "ans_x"})
        with self.assertRaises(LoopiterError):
            feedback_input({"answerId": "ans_x", "edit": "fix\u0007"})
        self.assertEqual(
            feedback_input({"answerId": "ans_x", "rating": {"kind": "thumbs", "value": "up"}}),
            {"answerId": "ans_x", "rating": {"kind": "thumbs", "value": "up"}},
        )

    async def test_feedback_cursor_advance_rewind_and_crash(self):
        store = InMemoryStore()
        loop = FeedbackLoop(store=store, namespace="app", clock=lambda: NOW)
        answer_id = served_answer_id({"namespace": "app", "answer": "The invoice is paid."})
        body = {
            "answerId": answer_id,
            "rating": {"kind": "numeric", "value": 0.2},
            "edit": "The invoice is unpaid.",
            "note": "reviewer",
        }
        first = await loop.record_feedback(**body)
        again = await loop.record_feedback(**body)
        self.assertEqual(again["id"], first["id"])
        async with store.transaction("app") as tx:
            promoted = await apply_feedback_cursor(tx, "app", NOW, "promote", "run_1")
        self.assertEqual(promoted["position"], first["id"])
        self.assertIsNone(promoted["previous"])
        async with store.transaction("app") as tx:
            repeat = await apply_feedback_cursor(tx, "app", NOW, "promote", "run_1")
            row = await tx.get("coordination", "feedback-cursor")
        self.assertEqual(repeat, promoted)
        self.assertEqual(row["revision"], 1)
        async with store.transaction("app") as tx:
            rewound = await apply_feedback_cursor(tx, "app", NOW, "rollback", "run_1")
        self.assertIsNone(rewound["position"])
        self.assertIsNone(rewound["promotion_id"])
        async with store.transaction("app") as tx:
            rewound_again = await apply_feedback_cursor(tx, "app", NOW, "rollback", "run_1")
        self.assertEqual(rewound_again, rewound)

        with self.assertRaises(LoopiterError):
            async with store.transaction("app") as tx:
                await persist_feedback(
                    tx, "app", NOW, feedback_input({"answerId": answer_id, "edit": "replacement"})
                )
                await apply_feedback_cursor(tx, "app", NOW, "promote", "run_crash")
                raise LoopiterError("callback_failed", "crash between steps")
        async with store.transaction("app") as tx:
            page = await tx.list("coordination", limit=100)
            cursor = await tx.get("coordination", "feedback-cursor")
        edits = [item["data"].get("edit") for item in page["items"]]
        self.assertNotIn("replacement", edits)
        self.assertIsNone(cursor["data"]["promotion_id"])

    async def test_caps_reset_on_utc_boundaries(self):
        store = InMemoryStore()
        caps = {"monthly_budget": 1, "call_cost": 1, "runs_per_day": 1}
        january = "2026-01-31T23:59:59.000Z"
        february = "2026-02-01T00:00:00.000Z"
        async with store.transaction("app") as tx:
            await admit_model_call(tx, "app", caps, january, "propose:0")
        async with store.transaction("app") as tx:
            self.assertEqual(await cap_block(tx, caps, january, "propose:0"), "daily_run_cap")
            self.assertEqual(
                await cap_block(tx, caps, january, "validation:candidate_1"), "budget_cap"
            )
            self.assertIsNone(await cap_block(tx, caps, february, "propose:0"))
            await admit_model_call(tx, "app", caps, january, "observe:1")
            runs = await tx.get("coordination", "cap-runs:2026-01-31")
        self.assertEqual(runs["data"]["count"], 1)


if __name__ == "__main__":
    unittest.main()
