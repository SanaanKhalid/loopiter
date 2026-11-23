import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
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
    served_answer_id,
)
from loopiter._validation import fail
from loopiter.feedback import feedback_cursor_id, target_scope
from loopiter.improvement import failure_detail_text
from loopiter.improvement_evidence import (
    compare,
    minimum_certifiable_audit_units,
    prepare_dataset,
    validate_change,
    validate_policy,
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


def _status_cli(args, **kwargs):
    return subprocess.run(args, **kwargs)


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

    async def test_immediate_confidence_stops_below_the_point_estimate_margin(self):
        self.setup_workflow({"name": "margin-validation", "scores": [1], "errors": 0})
        self.workflow.policy["objective"] = {
            **self.workflow.policy["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "minimum_improvement": 0.5,
            "confidence": 0.9,
            "bootstrap_samples": 200,
            "bootstrap_seed": 17,
        }

        async def validation_scores(input_, _context):
            return {
                "cases": [
                    {"id": row["id"], "baseline": 0, "candidate": 1 if index < 8 else 0}
                    for index, row in enumerate(input_["examples"])
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 1,
            }

        self.workflow = replace(self.workflow, evaluate=validation_scores)
        rejected = await self.controller().tick("classification")
        for _ in range(8):
            if rejected["reason"] == "below_minimum_improvement":
                break
            rejected = await self.controller().tick("classification")
        self.assertEqual(rejected["state"], "no_improvement")
        self.assertEqual(rejected["reason"], "below_minimum_improvement")
        self.assertEqual(self.registry.calls, 0)

        self.setup_workflow({"name": "margin-audit", "scores": [1], "errors": 0})
        self.workflow.policy["objective"] = {
            **self.workflow.policy["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "minimum_improvement": 0.5,
            "confidence": 0.9,
            "bootstrap_samples": 200,
            "bootstrap_seed": 17,
        }

        async def audit_scores(input_, _context):
            wins = input_["partition"] != "audit"
            return {
                "cases": [
                    {
                        "id": row["id"],
                        "baseline": 0,
                        "candidate": 1 if wins or index < 8 else 0,
                    }
                    for index, row in enumerate(input_["examples"])
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 1,
            }

        self.workflow = replace(self.workflow, evaluate=audit_scores)
        held = await self.controller().tick("classification")
        for _ in range(10):
            if held["reason"] == "below_minimum_improvement":
                break
            held = await self.controller().tick("classification")
        self.assertEqual(held["state"], "no_improvement")
        self.assertEqual(held["reason"], "below_minimum_improvement")
        self.assertEqual(self.registry.calls, 0)

    async def test_reviewed_rollback_keeps_the_cause_that_started_it(self):
        self.setup_workflow(
            {"name": "regression", "scores": [1], "errors": 0, "production_errors": 1}
        )
        result = await self.controller().tick("classification")
        for _ in range(8):
            if result["state"] == "rolling_back":
                break
            if result["state"] == "observing":
                self.now += timedelta(hours=2)
            result = await self.controller().tick("classification")
        self.assertEqual(result["state"], "rolling_back", result)
        self.assertEqual(result["reason"], "production_guardrail_failed")
        run = await self.controller().get_run(result["run_id"])
        await self.loop.rollback_candidate(run["data"]["selected_id"], self.registry)
        recovered = await self.controller().tick("classification")
        self.assertEqual(recovered["state"], "rolled_back")
        self.assertEqual(recovered["reason"], "reviewed_rollback_confirmed")
        self.assertEqual(recovered["cause"], "error_rate")

    async def test_confidence_waits_instead_of_burning_a_short_sample(self):
        self.setup_workflow({"name": "sparse", "scores": [1], "errors": 0})
        objective = {
            **self.workflow.policy["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "confidence": 0.9,
            "bootstrap_samples": 200,
            "bootstrap_seed": 17,
        }
        self.workflow.policy["objective"] = objective

        async def evaluate(input_, _context):
            return {
                "cases": [
                    {
                        "id": row["id"],
                        "baseline": 0,
                        "candidate": 1 if input_["partition"] == "validation" and index < 2 else 0,
                    }
                    for index, row in enumerate(input_["examples"])
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 1,
            }

        self.workflow = replace(self.workflow, evaluate=evaluate)
        result = await self.controller().tick("classification")
        for _ in range(6):
            if result["reason"] == "insufficient_decisive":
                break
            result = await self.controller().tick("classification")
        self.assertEqual(result["state"], "waiting_for_evidence")
        self.assertEqual(result["reason"], "insufficient_decisive")
        self.assertEqual(self.registry.calls, 0)
        run = await self.controller().get_run(result["run_id"])
        self.assertEqual(run["data"]["acceptance"]["decisive"], 2)
        self.assertEqual(run["data"]["acceptance"]["required"], 5)
        self.assertIsNone(run["data"]["acceptance"]["lower"])
        for candidate_id in run["data"]["candidate_ids"]:
            candidate = await self.loop.get_candidate(candidate_id)
            self.assertEqual(candidate["status"], "proposed")
        again = await self.controller().tick("classification")
        self.assertEqual(again["reason"], "unchanged_evidence")
        self.assertEqual(again["state"], "waiting_for_evidence")
        coordination = (await self.loop.list("coordination", limit=100))["items"]
        lock = next(row for row in coordination if row["id"].startswith("target:"))
        self.assertEqual(lock["data"].get("consecutive_failures", 0), 0)
        self.assertIsNone(lock["data"].get("active_run"))

        self.setup_workflow({"name": "loss", "scores": [0], "errors": 0})
        self.workflow.policy["objective"] = {
            **self.workflow.policy["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "confidence": 0.9,
            "bootstrap_samples": 200,
            "bootstrap_seed": 17,
        }

        async def losing(input_, _context):
            return {
                "cases": [
                    {"id": row["id"], "baseline": 1, "candidate": 0} for row in input_["examples"]
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 1,
            }

        self.workflow = replace(self.workflow, evaluate=losing)
        rejected = await self.controller().tick("classification")
        for _ in range(6):
            if rejected["reason"] == "validation_failed":
                break
            rejected = await self.controller().tick("classification")
        self.assertEqual(rejected["state"], "no_improvement")
        self.assertEqual(rejected["reason"], "validation_failed")
        loss_lock = next(
            row
            for row in (await self.loop.list("coordination", limit=100))["items"]
            if row["id"].startswith("target:")
        )
        self.assertEqual(loss_lock["data"].get("consecutive_failures"), 1)

        self.setup_workflow({"name": "audit-short", "scores": [1], "errors": 0})
        self.workflow.policy["objective"] = {
            **self.workflow.policy["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "confidence": 0.9,
            "bootstrap_samples": 200,
            "bootstrap_seed": 17,
        }

        async def audit_short(input_, _context):
            return {
                "cases": [
                    {
                        "id": row["id"],
                        "baseline": 0,
                        "candidate": 1 if input_["partition"] != "audit" or index < 2 else 0,
                    }
                    for index, row in enumerate(input_["examples"])
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 1,
            }

        self.workflow = replace(self.workflow, evaluate=audit_short)
        held = await self.controller().tick("classification")
        for _ in range(8):
            if held["reason"] == "insufficient_decisive":
                break
            held = await self.controller().tick("classification")
        self.assertEqual(held["state"], "waiting_for_evidence")
        self.assertEqual(held["reason"], "insufficient_decisive")
        self.assertEqual(self.registry.calls, 0)
        audited = await self.controller().get_run(held["run_id"])
        self.assertEqual(audited["data"]["acceptance"]["split"], "audit")
        self.assertEqual(audited["data"]["acceptance"]["decisive"], 2)
        candidate = await self.loop.get_candidate(audited["data"]["selected_id"])
        evaluation = candidate["evaluations"][-1]
        self.assertEqual(candidate["status"], "evaluated")
        self.assertIs(evaluation["passed"], False)
        self.assertEqual(evaluation["outcome"], "insufficient")
        self.assertEqual(evaluation["reason"], "insufficient_decisive")
        self.assertIn("2 of 5", evaluation["notes"])
        self.assertIn("not a rejection", evaluation["notes"])
        self.assertEqual(evaluation["metrics"]["decisive_items"], 2)
        self.assertEqual(evaluation["metrics"]["required_decisive"], 5)

    def test_confidence_policy_floor(self):
        base = deepcopy(FIXTURES["policy"])
        base["objective"] = {**base["objective"], "acceptance": "confidence", "minimum_effect": 0}
        validate_policy(base)
        short = deepcopy(base)
        short["minimum_validation_units"] = 4
        with self.assertRaises(LoopiterError) as caught:
            validate_policy(short)
        self.assertEqual(caught.exception.code, "invalid_policy")
        above = deepcopy(base)
        above["objective"] = {**above["objective"], "minimum_validation_decisive": 100}
        with self.assertRaises(LoopiterError) as exceeded:
            validate_policy(above)
        self.assertEqual(exceeded.exception.code, "invalid_policy")
        zero = deepcopy(base)
        zero["objective"] = {**zero["objective"], "minimum_audit_decisive": 0}
        with self.assertRaises(LoopiterError) as invalid:
            validate_policy(zero)
        self.assertEqual(invalid.exception.code, "invalid_input")
        under = deepcopy(base)
        under["objective"] = {**under["objective"], "minimum_validation_decisive": 4}
        with self.assertRaises(LoopiterError) as under_floor:
            validate_policy(under)
        self.assertEqual(under_floor.exception.code, "invalid_policy")
        audit_under = deepcopy(base)
        audit_under["objective"] = {**audit_under["objective"], "minimum_audit_decisive": 4}
        with self.assertRaises(LoopiterError) as audit_floor:
            validate_policy(audit_under)
        self.assertEqual(audit_floor.exception.code, "invalid_policy")
        at_floor = deepcopy(base)
        at_floor["objective"] = {
            **at_floor["objective"],
            "minimum_validation_decisive": 5,
            "minimum_audit_decisive": 5,
        }
        validate_policy(at_floor)
        fixed = deepcopy(FIXTURES["policy"])
        fixed["objective"] = {**fixed["objective"], "minimum_validation_decisive": 5}
        with self.assertRaises(LoopiterError) as fixed_error:
            validate_policy(fixed)
        self.assertEqual(fixed_error.exception.code, "invalid_policy")
        noise = deepcopy(base)
        noise["objective"] = {
            **noise["objective"],
            "noise_floor": {"validation": True, "audit": False},
        }
        validate_policy(noise)
        fixed_noise = deepcopy(FIXTURES["policy"])
        fixed_noise["objective"] = {**fixed_noise["objective"], "noise_floor": {"audit": True}}
        with self.assertRaises(LoopiterError) as noise_error:
            validate_policy(fixed_noise)
        self.assertEqual(noise_error.exception.code, "invalid_policy")
        bad_flag = deepcopy(base)
        bad_flag["objective"] = {**bad_flag["objective"], "noise_floor": {"validation": "yes"}}
        with self.assertRaises(LoopiterError) as flag_error:
            validate_policy(bad_flag)
        self.assertEqual(flag_error.exception.code, "invalid_policy")
        validate_policy(deepcopy(FIXTURES["policy"]))
        kept = deepcopy(base)
        kept["objective"] = {**kept["objective"], "retention": {"margin": 0.02}}
        validate_policy(kept)
        with_confidence = deepcopy(base)
        with_confidence["objective"] = {
            **with_confidence["objective"],
            "retention": {"margin": 0, "confidence": 0.8},
        }
        validate_policy(with_confidence)
        fixed_retention = deepcopy(FIXTURES["policy"])
        fixed_retention["objective"] = {
            **fixed_retention["objective"],
            "retention": {"margin": 0.02},
        }
        with self.assertRaises(LoopiterError) as retention_error:
            validate_policy(fixed_retention)
        self.assertEqual(retention_error.exception.code, "invalid_policy")
        missing = deepcopy(base)
        missing["objective"] = {**missing["objective"], "retention": {}}
        with self.assertRaises(LoopiterError):
            validate_policy(missing)
        negative = deepcopy(base)
        negative["objective"] = {**negative["objective"], "retention": {"margin": -0.01}}
        with self.assertRaises(LoopiterError) as negative_error:
            validate_policy(negative)
        self.assertEqual(negative_error.exception.code, "invalid_input")
        bad_confidence = deepcopy(base)
        bad_confidence["objective"] = {
            **bad_confidence["objective"],
            "retention": {"margin": 0.1, "confidence": 1},
        }
        with self.assertRaises(LoopiterError) as confidence_error:
            validate_policy(bad_confidence)
        self.assertEqual(confidence_error.exception.code, "invalid_policy")
        extra_retention = deepcopy(base)
        extra_retention["objective"] = {
            **extra_retention["objective"],
            "retention": {"margin": 0.1, "samples": 10},
        }
        with self.assertRaises(LoopiterError):
            validate_policy(extra_retention)

    async def _finish(self, controller):
        result = await controller.tick("classification")
        for _ in range(10):
            if result["state"] in (
                "completed",
                "no_improvement",
                "rolled_back",
                "waiting_for_evidence",
            ):
                return result
            if result["state"] == "observing":
                self.now += timedelta(hours=2)
            result = await controller.tick("classification")
        return result

    async def _ledger(self):
        page = await self.loop.list("coordination", limit=1000)
        target = next(row for row in page["items"] if str(row["id"]).startswith("target:"))
        return target["data"].get("retention") or {"best_ever": None, "decisions": []}

    def _ready(self, scores, margin, production_errors=0):
        self.setup_workflow(
            {
                "name": "accepted",
                "scores": scores,
                "errors": 0,
                "production_errors": production_errors,
            }
        )
        self.workflow.policy["objective"] = {
            **self.workflow.policy["objective"],
            "acceptance": "confidence",
            "minimum_effect": 0,
            "confidence": 0.9,
            "bootstrap_samples": 200,
            "bootstrap_seed": 17,
            "retention": {"margin": margin},
        }
        self.workflow.policy["daily"] = {"model_requests": 20, "tokens": 5000, "deployments": 5}

    async def _seed_best(self, score, count=50):
        from loopiter._validation import fingerprint

        now = self.now.isoformat().replace("+00:00", "Z")
        key = "target:" + fingerprint(self.workflow.policy["target"])
        items = [{"id": f"customer-audit-{index}", "score": score} for index in range(count)]
        async with self.loop.store.transaction(self.loop.namespace) as tx:
            await tx.insert(
                "coordination",
                {
                    "id": key,
                    "namespace": self.loop.namespace,
                    "revision": 1,
                    "created_at": now,
                    "updated_at": now,
                    "format": 1,
                    "data": {
                        "retention": {
                            "best_ever": {"id": "seeded", "score": score, "items": items},
                            "decisions": [],
                        }
                    },
                },
            )

    async def test_retention_blocks_regression_and_survives_rollback(self):
        self._ready([0.5], 0.05)
        controller = self.controller()
        first = await self._finish(controller)
        self.assertEqual(first["state"], "completed", first)
        self.assertEqual(self.registry.calls, 1)
        opened = await controller.get_run(first["run_id"])
        self.assertEqual(opened["data"]["retention"]["outcome"], "not_measured")
        self.assertIsNone(opened["data"]["retention"]["best_ever_id"])
        self.assertIsNone(opened["data"]["retention"]["lower"])
        self.assertIsNone(opened["data"]["retention"]["margin"])
        self.assertIsNone(opened["data"]["retention"]["items"])
        ledger = await self._ledger()
        self.assertEqual(ledger["best_ever"]["score"], 0.5)
        self.assertEqual(ledger["best_ever"]["id"], opened["data"]["selected_id"])
        self.assertIsNone(ledger["decisions"][-1]["items"])

        self._ready([0.2], 0.05)
        await self._seed_best(1)
        regressed = await self._finish(self.controller())
        self.assertEqual(regressed["state"], "no_improvement", regressed)
        self.assertEqual(regressed["reason"], "retention_regression")
        self.assertEqual(self.registry.calls, 0)
        ledger = await self._ledger()
        self.assertEqual(ledger["best_ever"]["id"], "seeded")
        self.assertEqual(ledger["best_ever"]["score"], 1)
        self.assertEqual(ledger["decisions"][-1]["outcome"], "retention_regression")
        self.assertLess(ledger["decisions"][-1]["lower"], -0.05)

        self._ready([0.5], 0.5)
        await self._seed_best(0.75)
        within = await self._finish(self.controller())
        self.assertEqual(within["state"], "completed", within)
        self.assertEqual(self.registry.calls, 1)
        ledger = await self._ledger()
        self.assertEqual(ledger["best_ever"]["id"], "seeded")
        self.assertEqual(ledger["best_ever"]["score"], 0.75)
        self.assertEqual(ledger["decisions"][-1]["outcome"], "pass")

        self._ready([1], 0.05, 0.5)
        await self._seed_best(0.5)
        controller = self.controller()
        rising = await controller.tick("classification")
        for _ in range(8):
            if rising["state"] in ("observing", "rolling_back"):
                break
            rising = await controller.tick("classification")
        self.assertEqual(rising["state"], "observing", rising)
        promoted = await controller.get_run(rising["run_id"])
        ledger = await self._ledger()
        self.assertEqual(ledger["best_ever"]["id"], "seeded")
        self.assertEqual(ledger["best_ever"]["score"], 0.5)
        self.assertNotEqual(ledger["best_ever"]["id"], promoted["data"]["selected_id"])
        self.now += timedelta(hours=2)
        rolled = await controller.tick("classification")
        for _ in range(4):
            if rolled["state"] == "rolled_back":
                break
            rolled = await controller.tick("classification")
        self.assertEqual(rolled["state"], "rolled_back", rolled)
        self.assertEqual(rolled["reason"], "previous_version_restored")
        self.assertEqual(rolled["cause"], "error_rate")
        after = await self._ledger()
        self.assertEqual(after["best_ever"]["id"], "seeded")
        self.assertEqual(after["best_ever"]["score"], 0.5)
        self.assertNotEqual(after["best_ever"]["id"], promoted["data"]["selected_id"])

        self._ready([0.4], 0.05)
        await self._seed_best(1, 2)
        held = await self._finish(self.controller())
        self.assertEqual(held["state"], "waiting_for_evidence", held)
        self.assertEqual(held["reason"], "insufficient_decisive")
        self.assertEqual(self.registry.calls, 0)
        held_run = await self.controller().get_run(held["run_id"])
        self.assertEqual(held_run["data"]["retention"]["outcome"], "insufficient")
        self.assertIsNone(held_run["data"]["retention"]["lower"])
        self.assertEqual(held_run["data"]["retention"]["items"], 2)
        held_ledger = await self._ledger()
        self.assertEqual(held_ledger["best_ever"]["id"], "seeded")
        self.assertEqual(held_ledger["best_ever"]["score"], 1)

        self._ready([1], 0.05)
        finished = await self._finish(self.controller())
        self.assertEqual(finished["state"], "completed", finished)
        opened = await self.controller().get_run(finished["run_id"])
        document = {
            "version": 3,
            "namespaces": {self.loop.namespace: self.loop.store._state[self.loop.namespace]},
        }
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            state_path.write_text(json.dumps(document), encoding="utf-8")
            shown = _status_cli(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "retention",
                    "status",
                    "--file",
                    str(state_path),
                    "--namespace",
                    self.loop.namespace,
                    "--json",
                ],
                cwd=directory,
                env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(shown.returncode, 0, shown.stderr)
            parsed = json.loads(shown.stdout)
            self.assertEqual(parsed["targets"][0]["bestEver"]["id"], opened["data"]["selected_id"])
            self.assertEqual(parsed["targets"][0]["bestEver"]["score"], 1)

    async def test_invalid_best_ever_fails_closed(self):
        from loopiter._validation import fingerprint

        self._ready([1], 0.05)
        now = self.now.isoformat().replace("+00:00", "Z")
        key = "target:" + fingerprint(self.workflow.policy["target"])
        async with self.loop.store.transaction(self.loop.namespace) as tx:
            await tx.insert(
                "coordination",
                {
                    "id": key,
                    "namespace": self.loop.namespace,
                    "revision": 1,
                    "created_at": now,
                    "updated_at": now,
                    "format": 1,
                    "data": {
                        "retention": {
                            "best_ever": {
                                "id": "bad",
                                "score": 1,
                                "items": [
                                    {"id": "customer-audit-0", "score": 1},
                                    {"id": "customer-audit-0", "score": 1},
                                ],
                            },
                            "decisions": [],
                        }
                    },
                },
            )
        result = await self.controller().tick("classification")
        for _ in range(8):
            if result["reason"] == "invalid_retention":
                break
            result = await self.controller().tick("classification")
        self.assertEqual(result["reason"], "invalid_retention", result)
        self.assertIn("Duplicate retention best-ever item id", result.get("detail") or "")
        self.assertEqual(self.registry.calls, 0)

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

    async def test_omitted_mode_is_autonomous_and_self_improving(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        controller = ImprovementController(self.loop, workflows=[self.workflow])
        self.assertEqual(controller.mode, "autonomous")
        self.assertIs(controller.self_improving, True)
        result = await controller.tick("classification")
        for _ in range(8):
            if result["state"] in (
                "completed",
                "no_improvement",
                "rolled_back",
                "waiting_for_evidence",
            ):
                break
            if result["state"] == "observing":
                self.now += timedelta(hours=2)
            result = await controller.tick("classification")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(self.registry.calls, 1)
        page = await self.loop.list("coordination", limit=1000)
        row = next(item for item in page["items"] if item["id"] == "workflow:classification")
        self.assertEqual(row["data"]["mode"], "autonomous")
        self.assertIs(row["data"]["self_improving"], True)

    async def test_promoted_run_consumes_seen_feedback_and_rollback_rewinds(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        target = self.workflow.policy["target"]
        scope = target_scope(target)
        answer_id = served_answer_id({"namespace": "test", "answer": "billing"})
        saved = await self.loop.record_feedback(
            answerId=answer_id, target=target, rating={"kind": "thumbs", "value": "up"}
        )
        result = await self.controller().tick("classification")
        later = await self.loop.record_feedback(
            answerId=answer_id, target=target, edit="after the run started"
        )
        for _ in range(8):
            if result["state"] in ("completed", "no_improvement", "rolled_back"):
                break
            if result["state"] == "observing":
                self.now += timedelta(hours=2)
            result = await self.controller().tick("classification")
        self.assertEqual(result["state"], "completed")
        async with self.loop.store.transaction("test") as tx:
            cursor = await tx.get("coordination", feedback_cursor_id(scope))
        self.assertEqual(cursor["data"]["position"], saved["id"])
        self.assertNotEqual(cursor["data"]["position"], later["id"])
        self.assertEqual(cursor["data"]["promotion_id"], result["run_id"])
        run = await self.controller().get_run(result["run_id"])
        await self.loop.rollback_candidate(run["data"]["selected_id"], self.registry)
        async with self.loop.store.transaction("test") as tx:
            rewound = await tx.get("coordination", feedback_cursor_id(scope))
        self.assertIsNone(rewound["data"]["position"])
        self.assertIsNone(rewound["data"]["promotion_id"])

        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["caps"] = {"runs_per_day": 0, "monthly_budget": 1, "call_cost": 1}
        calls = {"n": 0}

        async def propose(*_):
            calls["n"] += 1
            return [{"score": 1}]

        self.workflow = replace(self.workflow, propose=propose)
        idle = await self.controller().tick("classification")
        self.assertEqual(idle["reason"], "daily_run_cap")
        self.assertEqual(calls["n"], 0)
        self.assertIsNone(idle["run_id"])

        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["caps"] = {"monthly_budget": 0, "call_cost": 1}
        self.assertEqual((await self.controller().tick("classification"))["reason"], "budget_cap")

        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["caps"] = {"runs_per_day": 0, "monthly_budget": 0, "call_cost": 1}
        watching = ImprovementController(
            self.loop, workflows=[self.workflow], mode="observe", self_improving=True
        )
        self.assertEqual((await watching.tick("classification"))["reason"], "observation_only")

        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["caps"] = {"monthly_budget": 10, "call_cost": 1}
        proposed = {"n": 0}

        async def counting(*_):
            proposed["n"] += 1
            return [{"score": 1}]

        self.workflow = replace(self.workflow, propose=counting)
        original = self.loop.store.transaction

        @asynccontextmanager
        async def transaction(namespace):
            async with original(namespace) as tx:
                insert, replace_row = tx.insert, tx.replace

                async def wrapped_insert(collection, row):
                    if collection == "coordination" and str(row["id"]).startswith("cap-"):
                        fail("conflict", "injected")
                    return await insert(collection, row)

                async def wrapped_replace(collection, row, expected):
                    if collection == "coordination" and str(row["id"]).startswith("cap-"):
                        fail("conflict", "injected")
                    return await replace_row(collection, row, expected)

                tx.insert = wrapped_insert
                tx.replace = wrapped_replace
                yield tx

        self.loop.store.transaction = transaction
        paused = await self.controller().tick("classification")
        self.assertEqual(paused["reason"], "cap_conflict")
        self.assertNotEqual(paused["state"], "failed")
        self.assertEqual(proposed["n"], 0)
        async with self.loop.store.transaction("test") as tx:
            spent = await tx.get(
                "coordination",
                "cap-spend:" + target_scope(self.workflow.policy["target"]) + ":2026-02",
            )
        self.assertIsNone(spent)

        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["caps"] = {"monthly_budget": 10, "call_cost": 1}
        blocked = {"n": 0}

        async def blocked_propose(*_):
            blocked["n"] += 1
            return [{"score": 1}]

        self.workflow = replace(self.workflow, propose=blocked_propose)
        async with self.loop.store.transaction("test") as tx:
            await tx.insert(
                "coordination",
                {
                    "id": "cap-spend:" + target_scope(self.workflow.policy["target"]) + ":2026-02",
                    "namespace": "test",
                    "revision": 1,
                    "created_at": "2026-02-01T00:00:00.000Z",
                    "updated_at": "2026-02-01T00:00:00.000Z",
                    "format": 1,
                    "data": {"amount": "999"},
                },
            )
        stopped = await self.controller().tick("classification")
        self.assertEqual(stopped["reason"], "invalid_state")
        self.assertEqual(blocked["n"], 0)
        self.assertIsNone(stopped["run_id"])

    async def test_recommend_mode_stores_a_proposal_and_never_applies(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        controller = ImprovementController(self.loop, workflows=[self.workflow], mode="recommend")
        result = await controller.tick("classification")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["reason"], "recommendations_only")
        self.assertEqual(self.registry.calls, 0)
        self.assertEqual(self.proposals, 1)
        again = await controller.tick("classification")
        self.assertEqual(again["reason"], "unchanged_evidence")
        self.assertEqual(self.registry.calls, 0)

    async def test_disable_pauses_every_mode_before_a_provider_callback(self):
        for mode in ("recommend", "experiment", "observe", "autonomous"):
            self.setup_workflow(FIXTURES["scenarios"][0])
            calls = {"n": 0}

            async def touch(*_args, _calls=calls):
                _calls["n"] += 1
                raise AssertionError("provider")

            self.workflow = replace(self.workflow, artifact=touch, dataset=touch, propose=touch)
            result = await ImprovementController(
                self.loop, workflows=[self.workflow], mode=mode, self_improving=False
            ).tick("classification")
            self.assertEqual(result["state"], "paused", mode)
            self.assertEqual(result["reason"], "self_improvement_disabled", mode)
            self.assertEqual(calls["n"], 0, mode)
            self.assertEqual(self.registry.calls, 0, mode)

    async def test_opt_out_idles_autonomous_experiment_and_observe(self):
        for mode in ("autonomous", "experiment", "observe"):
            self.setup_workflow(FIXTURES["scenarios"][0])
            calls = {"n": 0}

            async def touch(*_args, _calls=calls):
                _calls["n"] += 1
                raise AssertionError("provider")

            self.workflow = replace(self.workflow, artifact=touch, dataset=touch, propose=touch)
            result = await ImprovementController(
                self.loop, workflows=[self.workflow], mode=mode, self_improving=False
            ).tick("classification")
            self.assertEqual(result["state"], "paused", mode)
            self.assertEqual(result["reason"], "self_improvement_disabled", mode)
            self.assertEqual(calls["n"], 0, mode)
            self.assertEqual(self.registry.calls, 0, mode)
            self.assertEqual(self.proposals, 0, mode)

    async def test_self_improving_on_follows_each_mode_gate(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        paused = self.controller(mode="autonomous", self_improving=True)
        await paused.pause("classification", "operator pause")
        held = await paused.tick("classification")
        self.assertEqual(held["state"], "paused")
        self.assertEqual(held["reason"], "workflow_paused")
        self.assertEqual(self.proposals, 0)
        self.assertEqual(self.registry.calls, 0)

        self.setup_workflow(FIXTURES["scenarios"][0])
        autonomous = self.controller(mode="autonomous", self_improving=True)
        result = await autonomous.tick("classification")
        for _ in range(8):
            if result["state"] in (
                "completed",
                "no_improvement",
                "rolled_back",
                "waiting_for_evidence",
            ):
                break
            if result["state"] == "observing":
                self.now += timedelta(hours=2)
            result = await autonomous.tick("classification")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(self.registry.calls, 1)
        self.assertGreater(self.proposals, 0)

        self.setup_workflow(FIXTURES["scenarios"][0])
        experiment = self.controller(mode="experiment", self_improving=True)
        audited = await experiment.tick("classification")
        for _ in range(8):
            if audited["state"] == "completed":
                break
            audited = await experiment.tick("classification")
        self.assertEqual(audited["state"], "completed")
        self.assertEqual(audited["reason"], "experiment_only")
        self.assertEqual(self.registry.calls, 0)
        self.assertGreater(self.proposals, 0)

        self.setup_workflow(FIXTURES["scenarios"][0])
        reads = {"n": 0}
        original = self.workflow.artifact

        async def artifact(ctx, _reads=reads, _original=original):
            _reads["n"] += 1
            return await _original(ctx)

        self.workflow = replace(self.workflow, artifact=artifact)
        seen = await self.controller(mode="observe", self_improving=True).tick("classification")
        self.assertEqual(seen["reason"], "observation_only")
        self.assertEqual(seen["state"], "waiting_for_evidence")
        self.assertGreater(reads["n"], 0)
        self.assertEqual(self.proposals, 0)
        self.assertEqual(self.registry.calls, 0)

    def test_failure_detail_rules_match_node(self):
        source = (Path(__file__).parents[2] / "src" / "failure-detail-rules.ts").read_text()
        start = source.index("export default ") + len("export default ")
        node = json.loads(source[start : source.rindex(" as const")])
        python = json.loads(
            (
                Path(__file__).parents[1] / "src" / "loopiter" / "failure_detail_rules.json"
            ).read_text()
        )
        self.assertEqual(node, python)

    async def test_null_mode_is_rejected_and_disable_env_fails_closed(self):
        from loopiter.improvement import improvement_work_disabled

        self.setup_workflow(FIXTURES["scenarios"][0])
        with self.assertRaises(LoopiterError) as error:
            ImprovementController(self.loop, workflows=[self.workflow], mode=None)
        self.assertEqual(error.exception.code, "invalid_input")
        previous = os.environ.get("LOOPITER_DISABLE")
        cases = [
            (None, False),
            ("", False),
            ("0", False),
            ("false", False),
            ("NO", False),
            (" off ", False),
            ("1", True),
            ("true", True),
            ("yes", True),
            ("on", True),
            ("y", True),
            ("enabled", True),
            ("disable", True),
            ("disabled", True),
            (" TRUE ", True),
        ]
        try:
            for value, disabled in cases:
                if value is None:
                    os.environ.pop("LOOPITER_DISABLE", None)
                else:
                    os.environ["LOOPITER_DISABLE"] = value
                self.assertEqual(improvement_work_disabled(), disabled, repr(value))
                self.setup_workflow(FIXTURES["scenarios"][0])
                calls = {"n": 0}

                async def propose(*_args, _calls=calls):
                    _calls["n"] += 1
                    return [{"score": 1}]

                self.workflow = replace(self.workflow, propose=propose)
                result = await ImprovementController(
                    self.loop, workflows=[self.workflow], mode="experiment"
                ).tick("classification")
                if disabled:
                    self.assertEqual(result["reason"], "self_improvement_disabled", repr(value))
                    self.assertEqual(calls["n"], 0, repr(value))
                else:
                    self.assertNotEqual(result["reason"], "self_improvement_disabled", repr(value))
                    self.assertEqual(calls["n"], 1, repr(value))
        finally:
            if previous is None:
                os.environ.pop("LOOPITER_DISABLE", None)
            else:
                os.environ["LOOPITER_DISABLE"] = previous

    async def test_default_autonomous_mode_blocks_a_losing_candidate(self):
        rejected = next(
            scenario for scenario in FIXTURES["scenarios"] if scenario["name"] == "rejected"
        )
        self.setup_workflow(rejected)
        controller = ImprovementController(self.loop, workflows=[self.workflow])
        result = await controller.tick("classification")
        for _ in range(8):
            if result["state"] == "no_improvement":
                break
            result = await controller.tick("classification")
        self.assertEqual(result["state"], "no_improvement")
        self.assertEqual(result["reason"], "validation_failed")
        self.assertEqual(self.registry.calls, 0)

    async def test_autonomous_fails_closed_without_audit_budget_or_enable(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        disabled = ImprovementController(
            self.loop, workflows=[self.workflow], mode="autonomous", self_improving=False
        )
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

    async def test_canary_observation_still_uses_the_lower_bound(self):
        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["rollout"]["mode"] = "canary"
        self.workflow.policy["objective"]["minimum_improvement"] = 0.05

        class Rollout:
            calls = 0

            async def promote(inner, *_):
                inner.calls += 1

            async def inspect(inner, *_):
                return "promoted"

        rollout, observe = Rollout(), self.workflow.observe

        async def blocked(i, c, observe=observe):
            return {
                **await observe(i, c),
                "control_version": i["baseline"]["artifact_version"],
                "assignment_hash": "stable-cohort-v1",
                "control_unit_ids": [f"control-{n}" for n in range(10)],
                "improvement_lower_bound": 0.04,
            }

        self.workflow = replace(self.workflow, rollout=rollout, observe=blocked)
        await self.advance_to_observation()
        self.now += timedelta(hours=2)
        held = await self.controller().tick("classification")
        self.assertEqual(held["reason"], "canary_not_superior")
        self.assertEqual(held["state"], "observing")
        self.assertEqual(rollout.calls, 0)

        self.setup_workflow(FIXTURES["scenarios"][0])
        self.workflow.policy["rollout"]["mode"] = "canary"
        self.workflow.policy["objective"]["minimum_improvement"] = 0.05
        cleared = Rollout()
        observe = self.workflow.observe

        async def passing(i, c, observe=observe):
            return {
                **await observe(i, c),
                "control_version": i["baseline"]["artifact_version"],
                "assignment_hash": "stable-cohort-v1",
                "control_unit_ids": [f"control-{n}" for n in range(10)],
                "improvement_lower_bound": 0.06,
            }

        self.workflow = replace(self.workflow, rollout=cleared, observe=passing)
        await self.advance_to_observation()
        self.now += timedelta(hours=2)
        promoted = await self.controller().tick("classification")
        self.assertEqual(promoted["state"], "completed")
        self.assertEqual(promoted["reason"], "canary_promoted")
        self.assertEqual(cleared.calls, 1)

    async def test_disable_setting_on_apply_paths(self):
        previous = os.environ.get("LOOPITER_DISABLE")
        try:
            self.setup_workflow(FIXTURES["scenarios"][0])
            self.workflow.policy["rollout"]["mode"] = "canary"

            class Rollout:
                calls = 0

                async def promote(inner, *_):
                    inner.calls += 1

                async def inspect(inner, *_):
                    return "promoted"

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
            os.environ["LOOPITER_DISABLE"] = "1"
            held = await self.controller().tick("classification")
            self.assertEqual(held["reason"], "promotion_paused")
            self.assertEqual(rollout.calls, 0)

            os.environ.pop("LOOPITER_DISABLE", None)
            self.setup_workflow(FIXTURES["scenarios"][0])
            ready = None
            for _ in range(8):
                ready = await self.controller().tick("classification")
                if ready["reason"] == "audit_passed":
                    break
            self.assertEqual(ready["reason"], "audit_passed")
            self.assertEqual(self.registry.calls, 0)
            os.environ["LOOPITER_DISABLE"] = "1"
            blocked = await self.controller().tick("classification")
            self.assertEqual(blocked["reason"], "self_improvement_disabled")
            self.assertEqual(self.registry.calls, 0)

            os.environ.pop("LOOPITER_DISABLE", None)
            regression = next(
                scenario for scenario in FIXTURES["scenarios"] if scenario["name"] == "regression"
            )
            self.setup_workflow(regression)
            await self.advance_to_observation()
            self.now += timedelta(hours=2)
            rolling = await self.controller().tick("classification")
            self.assertEqual(rolling["state"], "rolling_back")
            os.environ["LOOPITER_DISABLE"] = "1"
            recovered = await self.controller().tick("classification")
            self.assertEqual(recovered["state"], "rolled_back")
        finally:
            if previous is None:
                os.environ.pop("LOOPITER_DISABLE", None)
            else:
                os.environ["LOOPITER_DISABLE"] = previous

    async def test_disable_check_before_apply(self):
        previous = os.environ.get("LOOPITER_DISABLE")
        try:
            os.environ.pop("LOOPITER_DISABLE", None)
            self.setup_workflow(FIXTURES["scenarios"][0])
            ready = None
            for _ in range(8):
                ready = await self.controller().tick("classification")
                if ready["reason"] == "audit_passed":
                    break
            self.assertEqual(ready["reason"], "audit_passed")
            self.assertEqual(self.registry.calls, 0)
            original = self.workflow.artifact

            async def artifact(context, original=original):
                current = await original(context)
                os.environ["LOOPITER_DISABLE"] = "1"
                return current

            self.workflow = replace(self.workflow, artifact=artifact)
            blocked = await self.controller().tick("classification")
            self.assertEqual(blocked["reason"], "self_improvement_disabled")
            self.assertEqual(blocked["state"], "paused")
            self.assertEqual(self.registry.calls, 0)
            again = await self.controller().tick("classification")
            self.assertEqual(again["reason"], "self_improvement_disabled")
            self.assertEqual(again["state"], "paused")
            held = await self.controller().get_run(again["run_id"])
            self.assertEqual(held["data"]["state"], "paused")
            self.assertNotEqual(held["data"]["state"], "reconciliation_required")
            self.assertEqual(self.registry.calls, 0)
            attempts = (await self.loop.list("attempts", limit=100))["items"]
            self.assertEqual(len(attempts), 0)
            targets = (await self.loop.list("targets", limit=100))["items"]
            for target in targets:
                self.assertIsNone(target.get("pending_attempt_id"))
            coordination = (await self.loop.list("coordination", limit=1000))["items"]
            lock = next(row for row in coordination if row["id"].startswith("target:"))
            self.assertEqual(lock["data"].get("consecutive_failures", 0), 0)
            self.workflow = replace(self.workflow, artifact=original)
            os.environ.pop("LOOPITER_DISABLE", None)
            resumed = await self.controller().tick("classification")
            for _ in range(8):
                if resumed["state"] == "completed":
                    break
                if resumed["state"] == "observing":
                    self.now += timedelta(hours=2)
                resumed = await self.controller().tick("classification")
            self.assertEqual(resumed["state"], "completed")
            self.assertEqual(self.registry.calls, 1)
        finally:
            if previous is None:
                os.environ.pop("LOOPITER_DISABLE", None)
            else:
                os.environ["LOOPITER_DISABLE"] = previous

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

    def test_failure_text_redacts_hosts_and_credential_material(self):
        text = " ".join(
            [
                "contoso.openai.azure.com",
                "myres.openai.azure.com.",
                "westus.cognitiveservices.azure.com",
                "prod.azure.com",
                "contoso.azure-api.net",
                "contoso.openai.azure.us",
                "contoso.openai.azure.cn",
                "acct.blob.core.windows.net",
                "api.openai.com",
                "Bearer sk-bearersecretvalue",
                "sk-baresecretvalue99",
                '{"api_key":"json-secret-value"}',
                "?api-key=query-secret-value&x=1",
                "x-api-key: header-secret-value",
                "apiKey=kv-secret-value",
                "API-KEY: mixed-case-secret",
                "api_key = spaced-secret",
                "api_key:\nnewline-secret",
                "api-key%3Dencoded-secret",
                "Ocp-Apim-Subscription-Key=ocp-secret-value",
                "Subscription-Key=sub-key-secret",
                "authorization: raw-auth-secret",
                "Authorization=raw-auth-eq-secret",
                "Authorization: Basic basic-auth-secret",
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue",
                "AKIAABCDEFGHIJKLMNOP",
                "AccountKey=account-key-secret==",
                "?sv=2022&sig=sas-signature-secret",
                "postgres://admin:dsn-password-secret@db.internal:5432/app",
                "password=labeled-password-secret",
                "ghp_abcdefghijklmnopqrstuvwxyz",
                "https://example.com/path?q=1",
                "y" * 800,
            ]
        )
        detail = failure_detail_text(text)
        for secret in (
            "contoso.openai.azure.com",
            "myres.openai.azure.com",
            "westus.cognitiveservices.azure.com",
            "prod.azure.com",
            "contoso.azure-api.net",
            "contoso.openai.azure.us",
            "contoso.openai.azure.cn",
            "acct.blob.core.windows.net",
            "api.openai.com",
            "sk-bearersecretvalue",
            "sk-baresecretvalue99",
            "json-secret-value",
            "query-secret-value",
            "header-secret-value",
            "kv-secret-value",
            "mixed-case-secret",
            "spaced-secret",
            "newline-secret",
            "encoded-secret",
            "ocp-secret-value",
            "sub-key-secret",
            "raw-auth-secret",
            "raw-auth-eq-secret",
            "basic-auth-secret",
            "eyJhbGciOiJIUzI1NiJ9",
            "AKIAABCDEFGHIJKLMNOP",
            "account-key-secret",
            "sas-signature-secret",
            "dsn-password-secret",
            "labeled-password-secret",
            "ghp_abcdefghijklmnopqrstuvwxyz",
            "example.com",
        ):
            self.assertNotIn(secret, detail, secret)
        self.assertLessEqual(len(detail), 500)

    def test_failure_text_leaves_benign_wording_unchanged(self):
        for benign in (
            "signature mismatch in design=modern; apikeys rotated; the azure.com docs; risk-assessment",
            "task-runner disk-usage ask-me",
            "status code: 429",
            "code=context_length_exceeded",
            "Basic validation failed",
            "read the docs on platform.openai.com before retrying",
            "token: 4096 exceeds limit",
            "max_tokens=4096",
            "token_type=Bearer",
            "tokenizer=cl100k",
        ):
            self.assertEqual(failure_detail_text(benign), benign)

    def test_failure_text_matches_the_shared_probe_corpus(self):
        probes = json.loads(
            (Path(__file__).parent / "fixtures/failure-detail-probes.json").read_text()
        )
        for item in probes["cases"]:
            self.assertEqual(failure_detail_text(item["input"]), item["output"])

    def test_failure_text_finishes_on_a_long_unspaced_input(self):
        text = "api_key=early-secret " + ("a." * 100_000)
        started = time.perf_counter()
        detail = failure_detail_text(text)
        self.assertLess(time.perf_counter() - started, 1)
        self.assertNotIn("early-secret", detail)

    def test_failure_text_finishes_on_a_long_scheme_like_input(self):
        for text in ("a://" * 8192, "https://a:" * 3276):
            started = time.perf_counter()
            failure_detail_text(text)
            self.assertLess(time.perf_counter() - started, 1)

    async def test_chained_exception_text_is_sanitized(self):
        self.setup_workflow(FIXTURES["scenarios"][0])

        async def propose(_data, _context):
            raise RuntimeError("wrapper") from RuntimeError(
                "contoso.openai.azure.com sk-nestedsecretvalue api_key=nested-json-secret"
            )

        self.workflow = replace(self.workflow, propose=propose)
        result = await self.controller().tick("classification")
        detail = result["detail"]
        self.assertIn("wrapper", detail)
        self.assertIn("[redacted]", detail)
        self.assertNotIn("contoso.openai.azure.com", detail)
        self.assertNotIn("sk-nestedsecretvalue", detail)
        self.assertNotIn("nested-json-secret", detail)
        self.assertNotIn("contoso.openai.azure.com", json.dumps(result))

    async def test_sanitizer_failure_records_a_fixed_message(self):
        self.setup_workflow(FIXTURES["scenarios"][0])

        class Boom(RuntimeError):
            def __str__(self):
                raise RuntimeError("should-not-leak-secret")

        async def propose(_data, _context):
            raise Boom("unused")

        self.workflow = replace(self.workflow, propose=propose)
        result = await self.controller().tick("classification")
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["detail"], "[detail unavailable]")
        self.assertNotIn("should-not-leak-secret", json.dumps(result))
