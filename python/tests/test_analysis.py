import unittest

from loopiter import FeedbackLoop, InMemoryStore, LoopiterError


class AnalysisTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loop = FeedbackLoop(store=InMemoryStore(), namespace="analysis")

    async def execution(self, key, segment="billing", episode=None):
        args = {
            "id": key,
            "kind": "prediction",
            "metadata": {"segment": segment},
            "started_at": "2026-01-01T00:00:00Z",
        }
        if episode:
            args["episode_id"] = episode
        return await self.loop.record_execution(**args)

    async def signal(
        self,
        key,
        execution=None,
        episode=None,
        value=False,
        confidence=1,
        observed="2026-02-01T00:00:00Z",
        correction=None,
    ):
        args = {
            "id": key,
            "kind": "outcome",
            "name": "correct",
            "source": "verified",
            "value": value,
            "confidence": confidence,
            "observed_at": observed,
        }
        if execution:
            args["execution_id"] = execution
        if episode:
            args["episode_id"] = episode
        if correction:
            args["correction"] = correction
        return await self.loop.record_signal(**args)

    async def findings(self, **kwargs):
        return await self.loop.analyze(
            dimensions=["metadata.segment"], minimum_support=1, minimum_scored_count=1, **kwargs
        )

    async def test_delayed_outcome_and_independent_windows(self):
        await self.execution("e")
        await self.signal("s", execution="e")
        found = await self.findings(
            execution_window={"to": "2026-01-02T00:00:00Z"},
            observation_window={"from": "2026-02-01T00:00:00Z"},
        )
        self.assertEqual(found[0]["support"], 1)
        self.assertEqual(await self.findings(execution_window={"from": "2026-02-01T00:00:00Z"}), [])

    async def test_episode_outcome_deduplication(self):
        for i in range(8):
            await self.execution(f"e{i}", episode="one-episode")
        await self.signal("s", episode="one-episode")
        await self.signal("s", episode="one-episode")
        result = (await self.findings())[0]
        for key in (
            "support",
            "scored_count",
            "episode_count",
            "unique_signal_count",
            "effective_weight",
        ):
            self.assertEqual(result[key], 1)
        self.assertEqual(result["execution_count"], 8)

    async def test_zero_weight_and_unscored_evidence_not_support_or_recurrence(self):
        await self.execution("e")
        await self.signal("zero", execution="e", confidence=0, observed="2026-01-01T00:00:00Z")
        await self.signal(
            "unscored", execution="e", value={"note": "hi"}, observed="2026-01-02T00:00:00Z"
        )
        self.assertEqual(await self.findings(), [])
        await self.signal("scored", execution="e")
        result = (await self.findings())[0]
        self.assertEqual(result["recurrence"], 1)
        self.assertEqual(result["unique_signal_count"], 1)
        self.assertEqual(await self.findings(minimum_recurrence=2), [])

    async def test_positive_effect_gate_with_no_effect(self):
        await self.execution("e")
        await self.signal("s", execution="e")
        self.assertEqual(await self.findings(minimum_effect_size=0.1), [])

    async def test_descriptive_effect_and_fingerprint_versions(self):
        await self.execution("bad", "billing")
        await self.execution("good", "technical")
        await self.signal("bad-s", execution="bad")
        await self.signal("good-s", execution="good", value=True)
        result = await self.findings()
        self.assertEqual([r["effect_size"] for r in result], [-0.5, 0.5])
        self.assertNotIn("confidence", result[0])
        updated = await self.findings(scoring_version="v2")
        self.assertNotEqual(
            result[0]["evidence"]["fingerprint"], updated[0]["evidence"]["fingerprint"]
        )
        await self.loop.complete_execution(
            "bad", expected_revision=1, metadata={"note": "new evidence"}
        )
        self.assertNotEqual(
            result[0]["evidence"]["fingerprint"],
            (await self.findings())[0]["evidence"]["fingerprint"],
        )

    async def test_conflicting_corrections_preserved_not_independent_episodes(self):
        await self.execution("e", episode="ep")
        await self.signal("a", execution="e", correction={"label": "billing"})
        await self.signal("b", execution="e", correction={"label": "technical"}, value=True)
        result = (await self.findings())[0]
        self.assertEqual(result["support"], 1)
        self.assertEqual(result["unique_signal_count"], 2)
        self.assertEqual(len(result["correction_counts"]), 2)
        self.assertEqual(result["mean_score"], 0.5)

    async def test_limits_and_nonfinite_scores(self):
        for i in range(2):
            await self.execution(str(i))
            await self.signal(f"s{i}", execution=str(i))
        with self.assertRaises(LoopiterError) as error:
            await self.findings(maximum_records=1)
        self.assertEqual(error.exception.code, "query_limit")
        for kwargs in (
            {"score": lambda s: float("nan")},
            {"score": lambda s: True},
            {"minimum_effect_size": float("nan")},
            {"include_episode_signals": "yes"},
            {"maximum_records": 0},
            {"execution_kinds": "prediction"},
        ):
            with self.subTest(kwargs=str(kwargs)), self.assertRaises(LoopiterError):
                await self.findings(**kwargs)

    async def test_bad_adapter_page_is_rejected(self):
        await self.execution("e")
        original = self.loop._page
        for page in ({"items": [], "next_cursor": "never"}, {"items": "bad"}):
            with self.assertRaises(LoopiterError):
                original("executions", page, 10, None)
        record = await self.loop.get_execution("e")
        with self.assertRaises(LoopiterError):
            original("executions", {"items": [record, record]}, 10, None)


if __name__ == "__main__":
    unittest.main()
