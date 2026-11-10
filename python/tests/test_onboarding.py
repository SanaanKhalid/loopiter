import asyncio
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from loopiter.onboarding import (
    initialize_self_hosted,
    inspect_self_hosted_setup,
    read_agent_guide,
    read_reference,
    read_worker_settings,
    run_self_hosted_worker,
    verify_self_hosted_installation,
)

ROOT = Path(__file__).resolve().parents[2]


class OnboardingTests(unittest.TestCase):
    def test_init_preserves_files_and_records_autonomous_default(self):
        with tempfile.TemporaryDirectory(prefix="loopiter onboarding ") as root:
            destination = Path(root) / "my app"
            result = initialize_self_hosted(destination)
            self.assertFalse(result["connected"])
            self.assertEqual(result["schemaVersion"], 2)
            self.assertEqual(result["preset"], "autonomous-default")
            self.assertEqual(result["mode"], "autonomous")
            self.assertTrue(result["selfImproving"])
            self.assertEqual((destination / "AGENT_GUIDE.md").read_text(), read_agent_guide())
            plan = json.loads((destination / "integration-plan.json").read_text())
            self.assertEqual(plan["schemaVersion"], 2)
            self.assertEqual(plan["preset"], "autonomous-default")
            self.assertEqual(plan["mode"], "autonomous")
            self.assertTrue(plan["selfImproving"])
            self.assertEqual(
                set(plan),
                {
                    "schemaVersion",
                    "language",
                    "preset",
                    "mode",
                    "selfImproving",
                    "stepTimeoutMs",
                    "audit",
                    "namespace",
                    "applicationModule",
                    "storage",
                    "requiredEnvironment",
                    "reviewed",
                },
            )
            readme = (destination / "README.md").read_text()
            self.assertIn("--enable --mode autonomous --once", readme)
            self.assertIn("--enable --mode recommend --once", readme)
            self.assertIn("--enable authorizes improvement work and provider spending", readme)
            self.assertIn("fails closed without an audit partition, a budget, or --enable", readme)
            self.assertIn("Omitting --mode uses plan.mode", readme)
            self.assertIn("The --mode flag overrides the plan", readme)
            confirmation = (
                "Before the first run with --enable --mode autonomous, stop and get explicit "
                "confirmation from the human. That confirmation is one-time, for initial "
                "activation and spend. A completed checklist, doctor report, or plan output "
                "alone is not confirmation. After that one confirmation, autonomous runs "
                "continue without per-candidate approval."
            )
            self.assertIn(confirmation, readme)
            self.assertIn(confirmation, read_agent_guide())
            self.assertLess(
                readme.index(confirmation), readme.index("--enable --mode autonomous --once")
            )
            self.assertLess(
                readme.index("--enable --mode autonomous --once"),
                readme.index("--enable --mode recommend --once"),
            )
            marker = destination / "user-owned.txt"
            marker.write_text("preserve me")
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(destination)
            self.assertEqual(marker.read_text(), "preserve me")
            alias = Path(root) / "alias"
            alias.symlink_to(destination, target_is_directory=True)
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(alias)
            absent = Path(root) / "must-not-be-created"
            dangling = Path(root) / "dangling"
            dangling.symlink_to(absent, target_is_directory=True)
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(dangling)
            self.assertFalse(absent.exists())

    def test_doctor_never_imports_application_or_prints_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "setup"
            initialize_self_hosted(destination)
            self.assertFalse(inspect_self_hosted_setup(destination, {})["configured"])
            path = destination / "integration-plan.json"
            plan = json.loads(path.read_text())
            plan.update(
                namespace="app/dev", storage="postgres", requiredEnvironment=["APP_MODEL_KEY"]
            )
            plan["reviewed"] = dict.fromkeys(plan["reviewed"], True)
            path.write_text(json.dumps(plan))
            (destination / "application.py").write_text(
                "raise RuntimeError('doctor must not import this')\n"
            )
            self.assertFalse(inspect_self_hosted_setup(destination, {})["configured"])
            result = inspect_self_hosted_setup(
                destination, {"APP_MODEL_KEY": "private-test-sentinel"}
            )
            self.assertTrue(result["configured"])
            self.assertFalse(result["liveVerified"])
            self.assertEqual(result["mode"], "autonomous")
            self.assertTrue(result["selfImproving"])
            self.assertNotIn("private-test-sentinel", json.dumps(result))
            plan["requiredEnvironment"] = ["secret-value-with-punctuation!"]
            path.write_text(json.dumps(plan))
            with self.assertRaises(ValueError):
                inspect_self_hosted_setup(destination)

    def test_guide_distribution_and_reference_boundaries(self):
        root = Path(__file__).resolve().parents[2]
        if (root / "AGENT_GUIDE.md").is_file():
            self.assertEqual(read_agent_guide(), (root / "AGENT_GUIDE.md").read_text())
        self.assertIn("prompt_workflow", read_reference("workflows"))
        with self.assertRaises(ValueError):
            read_reference("../../.env")

    def test_schema_version_1_plans_stay_recommend_and_are_not_rewritten(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "legacy"
            initialize_self_hosted(destination)
            path = destination / "integration-plan.json"
            legacy = {
                "schemaVersion": 1,
                "language": "python",
                "mode": "recommend",
                "selfImproving": False,
                "namespace": "app/legacy",
                "applicationModule": "./application.py",
                "storage": "postgres",
                "requiredEnvironment": [],
                "reviewed": {
                    "target": True,
                    "feedback": True,
                    "evaluation": True,
                    "budgets": True,
                    "deployment": True,
                },
            }
            body = json.dumps(legacy, indent=2) + "\n"
            path.write_text(body)
            (destination / "application.py").write_text("pass\n")
            report = inspect_self_hosted_setup(destination, {})
            self.assertTrue(report["configured"])
            self.assertEqual(report["mode"], "recommend")
            self.assertFalse(report["selfImproving"])
            self.assertEqual(path.read_text(), body)
            legacy["schemaVersion"] = 3
            path.write_text(json.dumps(legacy))
            with self.assertRaisesRegex(ValueError, "schemaVersion 1 or 2"):
                inspect_self_hosted_setup(destination)


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_offline_verification_and_recovery_have_no_provider_calls(self):
        with patch(
            "urllib.request.OpenerDirector.open",
            side_effect=AssertionError("offline must not use network"),
        ):
            report = await verify_self_hosted_installation()
        self.assertEqual(report["providerCalls"], 0)
        self.assertEqual(len(report["checks"]), 5)
        self.assertTrue(all(check["passed"] for check in report["checks"]))

    async def test_worker_requires_enable_before_importing_code(self):
        with self.assertRaisesRegex(ValueError, "disabled"):
            await run_self_hosted_worker("does-not-exist.py", mode="autonomous", once=True)
        with self.assertRaises(ValueError):
            await run_self_hosted_worker("does-not-exist.py", self_improving=True, interval_ms=0)
        cancellation = asyncio.Event()
        cancellation.set()
        with self.assertRaises(asyncio.CancelledError):
            await run_self_hosted_worker(
                "does-not-exist.py", self_improving=True, cancellation=cancellation
            )

    async def test_real_controller_recommendation_and_cleanup(self):
        def snake(value):
            if isinstance(value, list):
                return [snake(item) for item in value]
            if isinstance(value, dict):
                return {
                    re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): child
                    if key == "changeSchema"
                    else snake(child)
                    for key, child in value.items()
                }
            return value

        policy = snake(
            json.loads((ROOT / "python/tests/fixtures/autonomy.json").read_text())["policy"]
        )
        with tempfile.TemporaryDirectory() as temporary:
            module = Path(temporary) / "application.py"
            closed = Path(temporary) / "closed"
            module.write_text(f"""
import json
from pathlib import Path
from loopiter import FeedbackLoop, InMemoryStore, ImprovementWorkflow
async def create_integration(*, cancellation):
    loop = FeedbackLoop(store=InMemoryStore(), namespace="worker/test")
    policy = json.loads({json.dumps(policy)!r})
    def rows(prefix, count, day):
        return [dict(id=prefix+str(i),episode_id=prefix+str(i),entity_id=prefix+str(i),occurred_at=f"2026-01-0{{day}}T00:00:00Z",observed_at=f"2026-01-0{{day}}T01:00:00Z",source=policy["trusted_sources"][0],input="test",label="yes") for i in range(count)]
    async def artifact(context): return dict(artifact_version="baseline",configuration_hash="fixed")
    async def dataset(context): return dict(version="1",optimization=rows("o",3,1),validation=rows("v",20,2),audit=rows("a",50,3))
    async def propose(data, context): return [dict(score=1)]
    async def evaluate(data, context): return dict(cases=[dict(id=row["id"],baseline=0,candidate=1) for row in data["examples"]],metrics=dict(errors=0),estimated_serving_cost=0)
    class Registry:
        async def apply(self, request): raise AssertionError("recommend must not deploy")
        async def rollback(self, request): raise AssertionError("unexpected rollback")
        async def inspect(self, request): return dict(status="unknown")
    async def observe(data, context): raise AssertionError("recommend must not observe a deployment")
    async def close():
        await loop.close()
        Path({str(closed)!r}).write_text("closed")
    workflow = ImprovementWorkflow(id="worker",version="1",optimizer_version="1",evaluator_version="1",policy=policy,dataset=dataset,artifact=artifact,propose=propose,evaluate=evaluate,deployment=Registry(),observe=observe)
    return dict(loop=loop,workflows=[workflow],close=close)
""")
            result = await run_self_hosted_worker(module, self_improving=True, once=True)
            self.assertEqual(len(result), 1)
            self.assertEqual(closed.read_text(), "closed")

    def test_doctor_audit_size_plan_mode_and_confirmation_flag(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "setup"
            initialize_self_hosted(destination)
            path = destination / "integration-plan.json"
            plan = json.loads(path.read_text())
            plan.update(
                namespace="app/dev",
                storage="postgres",
                requiredEnvironment=[],
                reviewed=dict.fromkeys(plan["reviewed"], True),
            )
            (destination / "application.py").write_text("raise RuntimeError('unused')\n")
            plan["audit"]["minimumUnits"] = 5
            path.write_text(json.dumps(plan))
            blocked = inspect_self_hosted_setup(destination, {})
            self.assertFalse(blocked["configured"])
            self.assertIn("At least 7 units are required", "\n".join(blocked["missing"]))
            plan["mode"] = "recommend"
            path.write_text(json.dumps(plan))
            warned = inspect_self_hosted_setup(destination, {})
            self.assertTrue(warned["configured"])
            self.assertIn("At least 7 units are required", "\n".join(warned["warnings"]))
            module = Path(root) / "application.py"
            plan["mode"] = "autonomous"
            plan["audit"]["minimumUnits"] = 50
            plan["stepTimeoutMs"] = 180000
            (Path(root) / "integration-plan.json").write_text(json.dumps(plan))
            module.write_text("raise RuntimeError('settings only')\n")
            settings = read_worker_settings(module)
            self.assertEqual(settings["mode"], "autonomous")
            self.assertEqual(settings["mode_source"], "plan")
            self.assertEqual(settings["step_timeout_ms"], 180000)
            flagged = read_worker_settings(
                module,
                mode="recommend",
                mode_source="flag",
                step_timeout_ms=90000,
                step_timeout_source="flag",
            )
            self.assertEqual(flagged["mode_source"], "flag")
            self.assertEqual(flagged["step_timeout_ms"], 90000)
            guide = read_agent_guide()
            self.assertIn("stepTimeoutMs >= 1000", guide)
            self.assertIn("minimum_certifiable_audit_units", guide)
            policy = json.loads((ROOT / "python/tests/fixtures/autonomy.json").read_text())[
                "policy"
            ]
            module.write_text(
                "import json\nfrom loopiter import FeedbackLoop, InMemoryStore, ImprovementWorkflow\n"
                "async def create_integration(*, cancellation):\n"
                "    loop = FeedbackLoop(store=InMemoryStore(), namespace='cli/confirm')\n"
                f"    policy = json.loads({json.dumps(json.dumps(snake_policy(policy)))})\n"
                "    def rows(prefix, count, day):\n"
                "        return [dict(id=prefix+str(i), episode_id=prefix+str(i), entity_id=prefix+str(i),"
                " occurred_at=f'2026-01-0{day}T00:00:00Z', observed_at=f'2026-01-0{day}T01:00:00Z',"
                " source=policy['trusted_sources'][0], input='test', label='yes') for i in range(count)]\n"
                "    async def artifact(context):\n"
                "        return dict(artifact_version='baseline', configuration_hash='fixed')\n"
                "    async def dataset(context):\n"
                "        return dict(version='1', optimization=rows('o',3,1), validation=rows('v',20,2), audit=rows('a',50,3))\n"
                "    async def propose(data, context): return [dict(score=1)]\n"
                "    async def evaluate(data, context):\n"
                "        return dict(cases=[dict(id=row['id'], baseline=0, candidate=1) for row in data['examples']],"
                " metrics=dict(errors=0), estimated_serving_cost=0)\n"
                "    class Registry:\n"
                "        async def apply(self, request): raise AssertionError('no')\n"
                "        async def rollback(self, request): raise AssertionError('no')\n"
                "        async def inspect(self, request): return dict(status='unknown')\n"
                "    async def observe(data, context): raise AssertionError('no')\n"
                "    workflow = ImprovementWorkflow(id='cli', version='1', optimizer_version='1', evaluator_version='1',"
                " policy=policy, dataset=dataset, artifact=artifact, propose=propose, evaluate=evaluate,"
                " deployment=Registry(), observe=observe)\n"
                "    return dict(loop=loop, workflows=[workflow], close=loop.close)\n"
            )
            denied = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--enable",
                    "--mode",
                    "autonomous",
                    "--once",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(denied.returncode, 1)
            self.assertIn("--confirm-activation or --yes", denied.stderr)
            allowed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--enable",
                    "--confirm-activation",
                    "--once",
                    "--step-timeout-ms",
                    "180000",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertIn("effective mode autonomous (source: plan)", allowed.stderr)
            self.assertIn("effective step timeout 180000ms (source: flag)", allowed.stderr)
            self.assertIn('"state": "evaluating"', allowed.stdout)


def snake_policy(value):
    if isinstance(value, list):
        return [snake_policy(item) for item in value]
    if isinstance(value, dict):
        return {
            re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): child
            if key == "changeSchema"
            else snake_policy(child)
            for key, child in value.items()
        }
    return value
