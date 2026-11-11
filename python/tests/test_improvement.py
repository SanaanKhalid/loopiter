import asyncio
import json
import re
import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from test_core import Registry

from loopiter import (
    FeedbackLoop,
    ImprovementController,
    ImprovementWorkflow,
    InMemoryStore,
    LoopiterError,
    assign_cohort,
)
from loopiter.improvement_evidence import (
    compare,
    minimum_certifiable_audit_units,
    prepare_dataset,
    validate_change,
)


def snake(value):
    if isinstance(value, list):
        return [snake(x) for x in value]
    if isinstance(value, dict):
        # The change schema intentionally uses standard JSON schema spellings.
        return {
            re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): (
                child if key == "changeSchema" else snake(child)
            )
            for key, child in value.items()
        }
    return value


FIXTURES = snake(json.loads((Path(__file__).parent / "fixtures/autonomy.json").read_text()))


def dataset():
    def row(name, index, day):
        return {
            "id": f"customer-{name}-{index}",
            "episode_id": f"ticket-{name}-{index}",
            "entity_id": f"person-{name}-{index}",
            "input": {"text": "Customer correction, not a fixture ID"},
            "label": "billing",
            "source": "verified-human",
            "occurred_at": f"2026-01-0{day}T00:00:00Z",
            "observed_at": f"2026-01-0{day}T01:00:00Z",
        }

    return {
        "version": "customer-export-1",
        "optimization": [row("train", i, 1) for i in range(3)],
        "validation": [row("validation", i, 2) for i in range(20)],
        "audit": [row("audit", i, 3) for i in range(50)],
    }


class ImprovementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = datetime(2026, 2, 1, tzinfo=UTC)
        self.clock = patch(
            "loopiter._validation.now", lambda: self.now.isoformat().replace("+00:00", "Z")
        )
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def setup_workflow(self, scenario):
        self.registry = Registry()
        if scenario["name"] == "interrupted":
            self.registry.fail = "after"
        self.loop = FeedbackLoop(store=InMemoryStore(), namespace="test")
        self.proposals, self.evaluations = 0, 0
        self.data = dataset()
        if scenario["name"] == "insufficient":
            self.data["audit"] = []

        async def artifact(_):
            return {
                "artifact_version": self.registry.version,
                "configuration_hash": "model-v1",
            }

        async def read_dataset(_):
            return self.data

        async def propose(_, ctx):
            self.proposals += 1

            async def request():
                return {"value": [{"score": s} for s in scenario["scores"]], "tokens": 40}

            return await ctx.meter(100, request)

        async def evaluate(input_, _):
            self.evaluations += 1
            return {
                "cases": [
                    {"id": r["id"], "baseline": 0, "candidate": input_["change"]["score"]}
                    for r in input_["examples"]
                ],
                "metrics": {"errors": scenario["errors"]},
                "estimated_serving_cost": 1,
            }

        async def observe(input_, _):
            return {
                "artifact_version": input_["artifact_version"],
                "configuration_hash": "model-v1",
                "started_at": input_["deployed_at"],
                "ended_at": self.now.isoformat().replace("+00:00", "Z"),
                "complete": scenario["name"] not in ("delayed", "missing"),
                "unit_ids": [f"production-{i}" for i in range(10)],
                "metrics": {"errors": scenario.get("production_errors", 0)},
            }

        self.workflow = ImprovementWorkflow(
            id="classification",
            version="1",
            optimizer_version="1",
            evaluator_version="paired-v1",
            policy=deepcopy(FIXTURES["policy"]),
            dataset=read_dataset,
            artifact=artifact,
            propose=propose,
            evaluate=evaluate,
            deployment=self.registry,
            observe=observe,
        )

    def controller(self, **options):
        return ImprovementController(
            self.loop,
            workflows=[self.workflow],
            **{"mode": "autonomous", "self_improving": True, **options},
        )

    async def test_shared_behavioral_fixtures(self):
        for scenario in FIXTURES["scenarios"]:
            with self.subTest(scenario=scenario["name"]):
                self.setup_workflow(scenario)
                result = await self.controller().tick("classification")
                for _ in range(8):
                    if result["state"] in (
                        "completed",
                        "no_improvement",
                        "rolled_back",
                        "waiting_for_evidence",
                    ):
                        break
                    if result["state"] == "observing":
                        self.now += timedelta(hours=25 if scenario["name"] == "missing" else 2)
                    result = await self.controller().tick("classification")
                    if (
                        scenario["name"] == "delayed"
                        and result["reason"] == "waiting_for_mature_outcomes"
                    ):
                        break
                self.assertEqual(result["state"], scenario["expected"], result)
                if scenario["name"] == "accepted":
                    run = await self.controller().get_run(result["run_id"])
                    candidate = await self.loop.get_candidate(run["data"]["selected_id"])
                    self.assertEqual(candidate["proposed_change"]["score"], 0.95)
                    self.assertEqual(self.registry.calls, 1)
                    calls = self.proposals, self.evaluations
                    await self.controller().tick("classification")
                    self.assertEqual((self.proposals, self.evaluations), calls)
                if scenario["name"] in ("regression", "missing"):
                    self.assertIsNone(self.registry.version)

    async def test_unrelated_passing_evaluation_cannot_replace_frozen_audit(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        await self.controller().tick("classification")
        selected = await self.controller().tick("classification")
        run = await self.controller().get_run(selected["run_id"])
        cid = run["data"]["selected_id"]

        async def external(*_):
            return {"passed": True, "metrics": {"errors": 0}}

        await self.loop.evaluate_candidate(
            cid,
            external,
            evaluator_name="external-review",
            version="different",
            dataset_hash="not-the-audit",
        )
        result = await self.controller().tick("classification")
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["reason"], "audit_evaluation_conflict")
        self.assertEqual(self.registry.calls, 0)
        self.assertIsNone((await self.loop.get_candidate(cid)).get("approval"))

    async def test_evaluation_race_before_approval_cannot_gain_authority(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        await self.controller().tick("classification")
        selected = await self.controller().tick("classification")
        run = await self.controller().get_run(selected["run_id"])
        cid, original = run["data"]["selected_id"], self.workflow.artifact

        async def external(*_):
            return {"passed": True}

        async def race(ctx):
            await self.loop.evaluate_candidate(
                cid,
                external,
                evaluator_name="external-review",
                version="different",
                dataset_hash="not-the-audit",
            )
            return await original(ctx)

        self.workflow = replace(self.workflow, artifact=race)
        result = await self.controller().tick("classification")
        self.assertEqual(result["reason"], "audit_evaluation_conflict")
        self.assertEqual(self.registry.calls, 0)

    async def test_omitted_mode_stays_recommend_and_never_applies(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        controller = ImprovementController(self.loop, workflows=[self.workflow])
        self.assertEqual(controller.mode, "recommend")
        self.assertIs(controller.self_improving, False)
        result = await controller.tick("classification")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["reason"], "recommendations_only")
        self.assertEqual(self.registry.calls, 0)
        self.assertEqual(self.proposals, 1)
        again = await controller.tick("classification")
        self.assertEqual(again["reason"], "unchanged_evidence")
        self.assertEqual(self.registry.calls, 0)
        page = await self.loop.list("coordination")
        row = next(item for item in page["items"] if item["id"] == "workflow:classification")
        self.assertEqual(row["data"]["mode"], "recommend")
        self.assertIs(row["data"]["self_improving"], False)

    async def test_autonomous_fails_closed_without_audit_budget_or_enable(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        disabled = ImprovementController(self.loop, workflows=[self.workflow], mode="autonomous")
        paused = await disabled.tick("classification")
        self.assertEqual(paused["reason"], "self_improvement_disabled")
        self.assertEqual(paused["state"], "paused")
        self.assertEqual(self.registry.calls, 0)
        self.assertEqual(self.proposals, 0)
        insufficient = next(
            scenario for scenario in FIXTURES["scenarios"] if scenario["name"] == "insufficient"
        )
        self.setup_workflow(insufficient)
        waiting = await self.controller().tick("classification")
        self.assertEqual(waiting["reason"], "insufficient_evidence")
        self.assertEqual(waiting["state"], "waiting_for_evidence")
        self.assertEqual(self.registry.calls, 0)
        self.setup_workflow(FIXTURES["scenarios"][0])
        del self.workflow.policy["daily"]["tokens"]
        with self.assertRaises(LoopiterError) as error:
            ImprovementController(
                self.loop,
                workflows=[self.workflow],
                mode="autonomous",
                self_improving=True,
            )
        self.assertEqual(error.exception.code, "invalid_input")
        self.assertEqual(self.registry.calls, 0)

    async def test_flag_and_concurrency(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        self.assertEqual(
            (await self.controller(self_improving=False).tick("classification"))["reason"],
            "self_improvement_disabled",
        )
        await asyncio.gather(
            self.controller().tick("classification"), self.controller().tick("classification")
        )
        self.assertEqual(self.proposals, 1)

    async def test_failed_evidence_dedup(self):
        self.setup_workflow(FIXTURES["scenarios"][1])
        await self.controller().tick("classification")
        await self.controller().tick("classification")
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "unchanged_evidence"
        )
        self.assertEqual(self.proposals, 1)

    async def test_baseline_drift(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        await self.controller().tick("classification")
        await self.controller().tick("classification")
        self.registry.version = "external"
        result = await self.controller().tick("classification")
        self.assertEqual(result["reason"], "stale_baseline")
        self.assertEqual(self.registry.calls, 0)

    async def test_contradictions_and_duplicate_episodes(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        self.data["optimization"].append(
            {**self.data["optimization"][0], "id": "conflict", "label": "other"}
        )
        self.data["audit"].append({**self.data["audit"][0], "id": "duplicate"})
        prepared = prepare_dataset(self.data, self.workflow.policy, "2026-02-01T00:00:00Z")
        self.assertEqual(len(prepared["optimization"]), 2)
        self.assertEqual(len(prepared["audit"]), 50)

    async def advance_to_observation(self):
        for _ in range(4):
            result = await self.controller().tick("classification")
        self.assertEqual(result["state"], "observing", result)
        return result

    async def test_unknown_usage_and_accounting(self):
        self.setup_workflow(FIXTURES["scenarios"][0])

        async def propose(_, ctx):
            async def request():
                raise RuntimeError("Unknown completion")

            return await ctx.meter(100, request)

        self.workflow = replace(self.workflow, propose=propose)
        result = await self.controller().tick("classification")
        self.assertEqual(result["budget"]["tokens"], 100)
        run = await self.controller().get_run(result["run_id"])
        self.assertEqual(run["accounting"]["charged_or_reserved_tokens"], 100)
        self.assertEqual(len(run["accounting"]["outstanding_operations"]), 1)
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "unchanged_evidence"
        )

    async def test_manual_apply_lock_and_reviewed_recovery(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        result = await self.advance_to_observation()
        run = await self.controller().get_run(result["run_id"])
        candidate = await self.loop.create_candidate(
            target=self.workflow.policy["target"],
            proposed_change={"score": 0.9},
            evidence={},
            risk="low",
        )

        async def passing(*_):
            return {"passed": True}

        evaluated = await self.loop.evaluate_candidate(
            candidate["id"],
            passing,
            evaluator_name="manual",
            version="1",
            dataset_hash="manual-fixture",
        )
        await self.loop.approve_candidate(
            candidate["id"], actor="test", evaluation_id=evaluated["evaluations"][0]["id"]
        )
        with self.assertRaises(LoopiterError) as error:
            await self.loop.deploy_candidate(candidate["id"], self.registry)
        self.assertEqual(error.exception.code, "target_busy")
        await self.controller().pause("classification", "manual recovery")
        await self.loop.rollback_candidate(run["data"]["selected_id"], self.registry)
        recovered = await self.controller().tick("classification")
        self.assertEqual(recovered["state"], "rolled_back")
        self.assertEqual(recovered["reason"], "reviewed_rollback_confirmed")

    async def test_pause_still_allows_recovery(self):
        self.setup_workflow(FIXTURES["scenarios"][5])
        await self.advance_to_observation()
        await self.controller().pause("classification", "operator pause")
        self.now += timedelta(hours=2)
        self.assertEqual((await self.controller().tick("classification"))["state"], "rolling_back")
        self.assertEqual(
            (await self.controller(self_improving=False).tick("classification"))["state"],
            "rolled_back",
        )

    async def test_observation_failure_preserves_deadline(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        await self.advance_to_observation()

        async def unavailable(*_):
            raise RuntimeError("monitor unavailable")

        self.workflow = replace(self.workflow, observe=unavailable)
        self.assertEqual((await self.controller().tick("classification"))["state"], "observing")
        self.now += timedelta(hours=25)
        self.assertEqual((await self.controller().tick("classification"))["state"], "rolling_back")

    async def test_canary_uncertain_promotion(self):
        for outcome in ("promoted", "not_applied", "unknown"):
            with self.subTest(outcome=outcome):
                self.setup_workflow(FIXTURES["scenarios"][0])
                self.workflow.policy["rollout"]["mode"] = "canary"

                class Rollout:
                    calls = 0

                    async def promote(inner, *_):
                        inner.calls += 1
                        raise RuntimeError("Lost promotion receipt")

                    async def inspect(inner, *_, outcome=outcome):
                        return outcome

                rollout, observe = Rollout(), self.workflow.observe

                async def canary(i, c, observe=observe):
                    return {
                        **await observe(i, c),
                        "control_version": i["baseline"]["artifact_version"],
                        "assignment_hash": "stable-cohort-v1",
                        "control_unit_ids": [f"control-{n}" for n in range(10)],
                        "improvement_lower_bound": 0.5,
                    }

                self.workflow = replace(self.workflow, rollout=rollout, observe=canary)
                await self.advance_to_observation()
                self.now += timedelta(hours=2)
                self.assertEqual(
                    (await self.controller().tick("classification"))["state"],
                    "reconciliation_required",
                )
                expected = {
                    "promoted": "completed",
                    "not_applied": "rolling_back",
                    "unknown": "reconciliation_required",
                }[outcome]
                self.assertEqual(
                    (await self.controller().tick("classification"))["state"], expected
                )
                self.assertEqual(rollout.calls, 1)
                if outcome == "not_applied":
                    self.assertEqual(
                        (await self.controller().tick("classification"))["state"], "rolled_back"
                    )

    async def test_out_of_band_change_blocks_rollback(self):
        self.setup_workflow(FIXTURES["scenarios"][5])
        await self.advance_to_observation()
        self.now += timedelta(hours=2)
        await self.controller().tick("classification")
        self.registry.version = "external-change"
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "out_of_band_change"
        )
        self.assertEqual(self.registry.version, "external-change")

    async def test_audit_reuse_and_new_evidence(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        for _ in range(3):
            await self.controller(mode="experiment").tick("classification")
        self.fresh_optimization("next")
        for _ in range(2):
            await self.controller(mode="experiment").tick("classification")
        self.assertEqual(
            (await self.controller(mode="experiment").tick("classification"))["reason"],
            "audit_consumed",
        )

    def fresh_optimization(self, prefix):
        self.data["version"] = prefix
        self.data["optimization"] = [
            {**r, **{key: prefix + r[key] for key in ("id", "entity_id", "episode_id")}}
            for r in self.data["optimization"]
        ]

    async def test_lease_loss_ignores_result(self):
        self.setup_workflow(FIXTURES["scenarios"][0])

        async def propose(*_):
            self.now += timedelta(hours=1)
            return [{"score": 1}]

        self.workflow = replace(self.workflow, propose=propose)
        result = await self.controller().tick("classification")
        self.assertEqual(result["candidate_ids"], [])
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "ambiguous_callback"
        )

    async def test_daily_budget_race(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["daily"]["model_requests"] = 1
        calls = []

        async def propose(_, ctx):
            async def request():
                calls.append(1)
                return {"value": [], "tokens": None}

            await asyncio.gather(ctx.meter(100, request), ctx.meter(100, request))
            return []

        self.workflow = replace(self.workflow, propose=propose)
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "budget_exhausted"
        )
        self.assertEqual(len(calls), 1)

    async def test_overage_is_charged(self):
        self.setup_workflow(FIXTURES["scenarios"][0])

        async def propose(_, ctx):
            async def request():
                return {"value": [{"score": 1}], "tokens": 150}

            return await ctx.meter(100, request)

        self.workflow = replace(self.workflow, propose=propose)
        result = await self.controller().tick("classification")
        self.assertEqual(result["reason"], "budget_contract")
        self.assertEqual(result["budget"]["tokens"], 150)

    async def test_flag_disable_during_callback(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        entered, release = asyncio.Event(), asyncio.Event()

        async def propose(*_):
            entered.set()
            await release.wait()
            return [{"score": 1}]

        self.workflow = replace(self.workflow, propose=propose)
        task = asyncio.create_task(self.controller().tick("classification"))
        await entered.wait()
        await self.controller(self_improving=False).tick("classification")
        release.set()
        result = await task
        self.assertEqual(result["reason"], "policy_changed")
        self.assertEqual(result["candidate_ids"], [])

    async def test_article_failure_stop_and_resume(self):
        self.setup_workflow(FIXTURES["scenarios"][1])
        histories, original = [], self.workflow.propose

        async def propose(i, c):
            histories.append(i["previous_outcomes"])
            self.assertEqual(c.configuration["policy_version"], "simulation-v1")
            return await original(i, c)

        self.workflow = replace(self.workflow, propose=propose)
        for cycle in range(3):
            self.fresh_optimization(str(cycle))
            await self.controller().tick("classification")
            self.assertEqual(
                (await self.controller().tick("classification"))["state"], "no_improvement"
            )
        self.assertEqual(len(histories[-1]), 2)
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"],
            "repeated_failures_require_review",
        )
        await self.controller().resume("classification")
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "unchanged_evidence"
        )

    async def test_cancellation_ignores_uncooperative_late_result(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        entered, release, cancel = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def propose(*_):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return [{"score": 1}]

        self.workflow = replace(self.workflow, propose=propose)
        task = asyncio.create_task(self.controller().tick("classification", cancel))
        await entered.wait()
        cancel.set()
        result = await task
        release.set()
        await asyncio.sleep(0)
        self.assertEqual(result["reason"], "cancelled")
        self.assertIsNotNone(result["run_id"])
        self.assertEqual(result["candidate_ids"], [])

    async def test_custom_audit_and_unicode_bounds(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        policy = self.workflow.policy
        policy["audit_method"] = {"name": "trusted-paired", "version": "1"}
        report = {
            "cases": [{"id": r["id"], "baseline": 0, "candidate": 0.5} for r in self.data["audit"]],
            "metrics": {"errors": 0},
            "estimated_serving_cost": 0,
            "uncertainty": {
                "method": "trusted-paired",
                "version": "1",
                "lower_bound": 0.2,
                "assumptions_valid": True,
            },
        }
        self.assertTrue(compare(report, self.data["audit"], policy, True)["passed"])
        report["uncertainty"]["assumptions_valid"] = False
        with self.assertRaises(LoopiterError):
            compare(report, self.data["audit"], policy, True)
        validate_change("🌀", {"type": "string", "maxLength": 1})
        with self.assertRaises(LoopiterError):
            validate_change("🌀x", {"type": "string", "maxLength": 1})
        a = assign_cohort(
            experiment_id="test", entity_id="customer-🌀", salt="private-salt", exposure=0.25
        )
        b = assign_cohort(
            experiment_id="test", entity_id="customer-🌀", salt="private-salt", exposure=0.75
        )
        self.assertEqual(a["bucket"], b["bucket"])

    async def test_step_timeout_and_uncertifiable_audit(self):
        objective = {"minimum_improvement": 0.05, "range": [0, 1], "alpha": 0.05}
        self.assertEqual(minimum_certifiable_audit_units(objective), 7)
        self.assertGreater(minimum_certifiable_audit_units(objective, 0.2), 7)
        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["minimum_audit_units"] = 5
        self.data["audit"] = self.data["audit"][:5]
        report = {
            "cases": [
                {"id": row["id"], "baseline": 0, "candidate": 1} for row in self.data["audit"]
            ],
            "metrics": {"errors": 0},
            "estimated_serving_cost": 0,
        }
        self.assertFalse(compare(report, self.data["audit"], self.workflow.policy, True)["passed"])
        self.assertEqual(
            (await self.controller().tick("classification"))["reason"], "audit_size_cannot_certify"
        )
        self.setup_workflow(FIXTURES["scenarios"][0])
        self.controller(step_timeout_ms=180000)
        self.controller(step_timeout_ms=7_200_000)
        with self.assertRaises(LoopiterError):
            self.controller(step_timeout_ms=7_200_001)

        audit_calls = {"n": 0}

        async def evaluate(data, context):
            if data["partition"] == "audit":
                audit_calls["n"] += 1
                try:
                    await asyncio.wait_for(context.cancellation.wait(), 2)
                except TimeoutError:
                    pass
            return {
                "cases": [
                    {"id": row["id"], "baseline": 0, "candidate": 1} for row in data["examples"]
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 0,
            }

        self.workflow = replace(self.workflow, evaluate=evaluate)
        controller = self.controller(callback_timeout_ms=40)
        result = await controller.tick("classification")
        for _ in range(5):
            if result["state"] == "timed_out":
                break
            result = await controller.tick("classification")
        self.assertEqual(result["state"], "timed_out")
        self.assertEqual(result["reason"], "timed_out")
        run = await controller.get_run(result["run_id"])
        coordination = (await self.loop.list("coordination", limit=1000))["items"]
        self.assertTrue(any(row["id"].startswith("audit:") for row in coordination))
        sent = audit_calls["n"]
        self.data["version"] = "export-reuse"
        self.data["optimization"] = [
            {
                **row,
                "id": f"reuse-{row['id']}",
                "episode_id": f"reuse-{row['episode_id']}",
                "entity_id": f"reuse-{row['entity_id']}",
            }
            for row in self.data["optimization"]
        ]
        reused = await controller.tick("classification")
        for _ in range(8):
            if reused["reason"] == "audit_consumed":
                break
            reused = await controller.tick("classification")
        self.assertEqual(reused["reason"], "audit_consumed")
        self.assertEqual(audit_calls["n"], sent)
        target = next(row for row in coordination if row["id"].startswith("target:"))
        self.assertEqual(target["data"].get("consecutive_failures", 0), 0)
        self.assertEqual(target["data"]["consecutive_timeouts"], 1)
        for cid in run["data"]["candidate_ids"]:
            self.assertEqual((await self.loop.get_candidate(cid))["status"], "rejected")
        stale = await self.loop.create_candidate(
            target=self.workflow.policy["target"],
            proposed_change={"score": 0.4},
            evidence={},
            risk="low",
            metadata={"run_id": run["id"]},
        )
        await self.controller().tick("classification")
        self.assertEqual((await self.loop.get_candidate(stale["id"]))["status"], "rejected")
        for cycle in (2, 3):
            self.data["version"] = f"export-{cycle}"
            self.data["optimization"] = [
                {
                    **row,
                    "id": f"{cycle}-{row['id']}",
                    "episode_id": f"{cycle}-{row['episode_id']}",
                    "entity_id": f"{cycle}-{row['entity_id']}",
                }
                for row in self.data["optimization"]
            ]
            self.data["audit"] = [
                {
                    **row,
                    "id": f"{cycle}-{row['id']}",
                    "episode_id": f"{cycle}-{row['episode_id']}",
                    "entity_id": f"{cycle}-{row['entity_id']}",
                }
                for row in self.data["audit"]
            ]
            result = await controller.tick("classification")
            for _ in range(5):
                if result["state"] == "timed_out":
                    break
                result = await controller.tick("classification")
            self.assertEqual(result["state"], "timed_out")
        self.data["version"] = "export-4"
        self.data["optimization"] = [
            {
                **row,
                "id": f"4-{row['id']}",
                "episode_id": f"4-{row['episode_id']}",
                "entity_id": f"4-{row['entity_id']}",
            }
            for row in self.data["optimization"]
        ]
        self.data["audit"] = [
            {
                **row,
                "id": f"4-{row['id']}",
                "episode_id": f"4-{row['episode_id']}",
                "entity_id": f"4-{row['entity_id']}",
            }
            for row in self.data["audit"]
        ]
        self.assertEqual(
            (await controller.tick("classification"))["reason"],
            "repeated_timeouts_require_review",
        )

    async def test_callback_failure_keeps_redacted_detail(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        host = "https://secret.example.openai.azure.com/openai"
        key = "sk-test-secret-value"

        async def propose(_data, _context):
            raise RuntimeError(
                f"proposal exploded at {host} api-key: {key} authorization: Bearer {key} "
                + ("y" * 800)
            )

        self.workflow = replace(self.workflow, propose=propose)
        controller = self.controller()
        result = await controller.tick("classification")
        self.assertEqual(result["reason"], "callback_failed")
        self.assertEqual(result["state"], "failed")
        detail = result["detail"]
        self.assertIn("proposal exploded", detail)
        self.assertNotIn(host, detail)
        self.assertNotIn("secret.example.openai.azure.com", detail)
        self.assertNotIn(key, detail)
        self.assertLessEqual(len(detail), 500)
        run = await controller.get_run(result["run_id"])
        self.assertEqual(run["data"]["detail"], detail)
