import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from loopiter.onboarding import (
    autonomous_activation_prompt,
    autonomy_plan_hash,
    clear_autonomous_activation,
    initialize_self_hosted,
    inspect_self_hosted_setup,
    read_agent_guide,
    read_reference,
    read_worker_settings,
    record_autonomous_activation,
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
            self.assertIn("--mode recommend --once", readme)
            self.assertNotIn("--disable --mode", readme)
            recipe = next(
                line.strip()
                for line in readme.splitlines()
                if "loopiter worker" in line and "--mode" not in line
            )
            self.assertIn("--once", recipe)
            self.assertNotIn("--enable", recipe)
            self.assertNotIn("--mode", recipe)
            self.assertIn("The worker runs without --enable", readme)
            self.assertIn("LOOPITER_DISABLE=1", readme)
            self.assertIn("fails closed without an audit partition or a budget", readme)
            self.assertIn("The recipe above omits --mode, so plan.mode controls it", readme)
            self.assertIn("The --mode flag still overrides the plan", readme)
            migration = "An ImprovementController created with no mode is autonomous with self-improving on."
            self.assertIn(migration, readme)
            self.assertIn(migration, read_agent_guide())
            self.assertIn("cannot exceed two hours", read_agent_guide())
            self.assertIn("LOOPITER_DISABLE=1", read_agent_guide())
            self.assertIn("Namespace: app/shown", autonomous_activation_prompt("app/shown"))
            self.assertIn("Type activate to confirm:", autonomous_activation_prompt("app/shown"))
            self.assertLess(readme.index(migration), readme.index(recipe))
            self.assertLess(readme.index(recipe), readme.index("--mode recommend --once"))
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

    def test_init_appends_state_gitignore_once(self):
        root_ignore = (ROOT / ".gitignore").read_text()
        self.assertRegex(root_ignore, r"(?m)^\.state/$")
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "existing"
            destination.mkdir()
            (destination / ".gitignore").write_text("dist")
            (destination / "user-owned.txt").write_text("keep")
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(destination)
            once = (destination / ".gitignore").read_text()
            self.assertEqual(once, "dist\n.state/\n")
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(destination)
            self.assertEqual((destination / ".gitignore").read_text(), once)
            self.assertEqual((destination / "user-owned.txt").read_text(), "keep")
            already = Path(root) / "already"
            already.mkdir()
            (already / ".gitignore").write_text("# .state/\n!.state/\n/.state/\n")
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(already)
            self.assertEqual(
                (already / ".gitignore").read_text(),
                "# .state/\n!.state/\n/.state/\n",
            )
            commented = Path(root) / "commented"
            commented.mkdir()
            (commented / ".gitignore").write_text("# .state/\n")
            with self.assertRaises(FileExistsError):
                initialize_self_hosted(commented)
            self.assertEqual((commented / ".gitignore").read_text(), "# .state/\n.state/\n")

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

    async def test_worker_validates_settings_before_importing_code(self):
        with self.assertRaises(FileNotFoundError):
            await run_self_hosted_worker(
                "does-not-exist.py", mode="autonomous", self_improving=False, once=True
            )
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
            result = await run_self_hosted_worker(
                module, mode="recommend", self_improving=True, once=True
            )
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
            blocked_text = "\n".join(blocked["missing"])
            self.assertIn("At least 7 units are required", blocked_text)
            self.assertIn("not a gain 7 units can certify", blocked_text)
            self.assertIn("a gain of 0.05 does not exceed", blocked_text)
            self.assertIn("a gain of 0.10 needs 2397 units", blocked_text)
            self.assertIn("a gain of 0.20 needs 267 units", blocked_text)
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
            self.assertIn("not a gain that 7 units can certify", guide)
            self.assertIn("A gain of 0.10 needs 2397 units", guide)
            self.assertIn("a gain of 0.20 needs 267 units", guide)
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

            def run_worker(extra, env=None):
                return subprocess.run(
                    [sys.executable, "-m", "loopiter", "worker", "--module", str(module), *extra],
                    cwd=root,
                    input="",
                    text=True,
                    capture_output=True,
                    check=False,
                    env=None if env is None else {**os.environ, **env},
                )

            plain = run_worker(["--once", "--step-timeout-ms", "180000"])
            self.assertEqual(plain.returncode, 0, plain.stderr)
            self.assertIn("effective mode autonomous (source: plan)", plain.stderr)
            self.assertIn("effective step timeout 180000ms (source: flag)", plain.stderr)
            self.assertNotIn("deprecated", plain.stderr)
            self.assertIn('"state": "evaluating"', plain.stdout)
            self.assertFalse((Path(root) / ".state" / "activation.json").exists())
            legacy = run_worker(["--enable", "--confirm-activation", "--yes", "--once"])
            self.assertEqual(legacy.returncode, 0, legacy.stderr)
            self.assertIn("--enable is deprecated and ignored", legacy.stderr)
            self.assertIn("--confirm-activation is deprecated and ignored", legacy.stderr)
            self.assertIn("--yes is deprecated and ignored", legacy.stderr)
            disabled = run_worker(["--disable", "--once"])
            self.assertEqual(disabled.returncode, 0, disabled.stderr)
            self.assertIn('"reason": "self_improvement_disabled"', disabled.stdout)
            for value in ("1", "true", "yes"):
                env_disabled = run_worker(["--once"], {"LOOPITER_DISABLE": value})
                self.assertEqual(env_disabled.returncode, 0, env_disabled.stderr)
                self.assertIn('"reason": "self_improvement_disabled"', env_disabled.stdout)
            original_module = module.read_text()
            self.assertIn('\\"tokens\\": 1000', original_module)
            module.write_text(
                original_module.replace('\\"tokens\\": 1000', '\\"tokens\\": 100000', 1)
            )
            cache = Path(root) / "__pycache__"
            if cache.exists():
                shutil.rmtree(cache)
            changed_module_budget = run_worker(["--once"])
            self.assertEqual(changed_module_budget.returncode, 0, changed_module_budget.stderr)
            self.assertNotIn("one-time confirmation", changed_module_budget.stderr)
            module.write_text(original_module)
            if cache.exists():
                shutil.rmtree(cache)
            plan_path = Path(root) / "integration-plan.json"
            stored = json.loads(plan_path.read_text())
            stored["budget"] = {"tokens": 1000}
            plan_path.write_text(json.dumps(stored))
            changed_budget = run_worker(["--once"])
            self.assertEqual(changed_budget.returncode, 0, changed_budget.stderr)
            self.assertNotIn("one-time confirmation", changed_budget.stderr)
            del stored["budget"]
            stored["namespace"] = "app/other"
            plan_path.write_text(json.dumps(stored))
            fresh = run_worker(["--once"])
            self.assertEqual(fresh.returncode, 0, fresh.stderr)
            self.assertNotIn("one-time confirmation", fresh.stderr)
            stored["namespace"] = "app/dev"
            stored["audit"]["minimumUnits"] = 60
            plan_path.write_text(json.dumps(stored))
            changed = run_worker(["--once"])
            self.assertEqual(changed.returncode, 0, changed.stderr)
            self.assertNotIn("one-time confirmation", changed.stderr)

    def test_documented_recipe_follows_plan_mode_recommend(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "setup"
            initialize_self_hosted(destination)
            readme = (destination / "README.md").read_text()
            recipe = next(
                line.strip()
                for line in readme.splitlines()
                if "loopiter worker" in line and "--mode" not in line
            )
            self.assertIn("--once", recipe)
            self.assertNotIn("--enable", recipe)
            self.assertNotIn("--mode", recipe)
            plan_path = destination / "integration-plan.json"
            plan = json.loads(plan_path.read_text())
            plan["mode"] = "recommend"
            plan["namespace"] = "app/dev"
            plan_path.write_text(json.dumps(plan))
            module = destination / "application.py"
            module.write_text("raise RuntimeError('unused')\n")
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--once",
                ],
                cwd=destination,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertIn("effective mode recommend (source: plan)", result.stderr)
            self.assertNotIn("effective mode autonomous", result.stderr)

    def test_failed_preflight_does_not_record_confirmation(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            module = root_path / "application.py"
            (root_path / "integration-plan.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "language": "python",
                        "mode": "autonomous",
                        "selfImproving": True,
                        "namespace": "app/dev",
                        "stepTimeoutMs": 120000,
                        "audit": {
                            "method": "paired-hoeffding",
                            "minimumImprovement": 0.05,
                            "range": [0, 1],
                            "alpha": 0.05,
                            "minimumUnits": 50,
                        },
                    }
                )
            )
            module.write_text(
                "import os\n"
                "from loopiter import FeedbackLoop, InMemoryStore\n"
                "async def create_integration(*, cancellation):\n"
                "    if not os.environ.get('DATABASE_URL'):\n"
                "        raise RuntimeError('DATABASE_URL is required.')\n"
                "    if os.environ['DATABASE_URL'] != 'postgres://reachable':\n"
                "        raise RuntimeError('registry unreachable')\n"
                "    loop = FeedbackLoop(store=InMemoryStore(), namespace='app/dev')\n"
                "    return {'loop': loop, 'workflows': [], 'close': loop.close}\n"
            )

            base_env = {key: value for key, value in os.environ.items() if key != "DATABASE_URL"}

            def run(env):
                return subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "loopiter",
                        "worker",
                        "--module",
                        str(module),
                        "--once",
                    ],
                    cwd=root,
                    input="",
                    text=True,
                    capture_output=True,
                    check=False,
                    env={**base_env, **env},
                )

            missing = run({})
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("DATABASE_URL is required", missing.stderr)
            self.assertFalse((root_path / ".state" / "activation.json").exists())
            unreachable = run({"DATABASE_URL": "postgres://down"})
            self.assertNotEqual(unreachable.returncode, 0)
            self.assertIn("registry unreachable", unreachable.stderr)
            self.assertFalse((root_path / ".state" / "activation.json").exists())
            ready = run({"DATABASE_URL": "postgres://reachable"})
            self.assertNotEqual(ready.returncode, 0, ready.stderr)
            self.assertFalse((root_path / ".state" / "activation.json").exists())

    def test_step_timeout_rejects_non_decimal_integers(self):
        with tempfile.TemporaryDirectory() as root:
            for value in ("1e5", "120000.0", "0x1e240"):
                result = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "loopiter",
                        "worker",
                        "--module",
                        "missing.py",
                        "--step-timeout-ms",
                        value,
                    ],
                    cwd=root,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0, value)
                self.assertIn("invalid int value", result.stderr)
            module = Path(root) / "application.py"
            module.write_text("raise RuntimeError('unused')\n")
            self.assertEqual(
                read_worker_settings(module, step_timeout_ms=7_200_000)["step_timeout_ms"],
                7_200_000,
            )
            with self.assertRaises(ValueError):
                read_worker_settings(module, step_timeout_ms=7_200_001)
            for literal in ("1e5", "120000.0"):
                (Path(root) / "integration-plan.json").write_text(
                    '{"schemaVersion":2,"language":"python","mode":"recommend","selfImproving":false,'
                    f'"namespace":"app/dev","stepTimeoutMs":{literal}}}\n'
                )
                with self.assertRaises(ValueError):
                    read_worker_settings(module)

    def test_tty_prompt_shows_namespace_and_failed_tick_drops_stamp(self):
        with tempfile.TemporaryDirectory() as root:
            module = Path(root) / "application.py"
            module.write_text("raise RuntimeError('imported too early')\n")
            (Path(root) / "integration-plan.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "language": "python",
                        "mode": "autonomous",
                        "selfImproving": True,
                        "namespace": "app/shown",
                        "stepTimeoutMs": 120000,
                    }
                )
            )
            output = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--once",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(output.returncode, 0)
            self.assertIn("imported too early", output.stderr)
            self.assertNotIn("Type activate", output.stderr)
            self.assertNotIn("one-time confirmation", output.stderr)
            self.assertFalse((Path(root) / ".state" / "activation.json").exists())

        policy = snake_policy(
            json.loads((ROOT / "python/tests/fixtures/autonomy.json").read_text())["policy"]
        )
        with tempfile.TemporaryDirectory() as root:
            module = Path(root) / "application.py"
            (Path(root) / "integration-plan.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "language": "python",
                        "mode": "autonomous",
                        "selfImproving": True,
                        "namespace": "app/dev",
                        "stepTimeoutMs": 120000,
                        "audit": {
                            "method": "paired-hoeffding",
                            "minimumImprovement": 0.05,
                            "range": [0, 1],
                            "alpha": 0.05,
                            "minimumUnits": 50,
                        },
                    }
                )
            )
            module.write_text(
                "import json\nfrom loopiter import FeedbackLoop, InMemoryStore, ImprovementWorkflow\n"
                "async def create_integration(*, cancellation):\n"
                "    loop = FeedbackLoop(store=InMemoryStore(), namespace='cli/fail')\n"
                f"    policy = json.loads({json.dumps(json.dumps(policy))})\n"
                "    def rows(prefix, count, day):\n"
                "        return [dict(id=prefix+str(i), episode_id=prefix+str(i), entity_id=prefix+str(i),"
                " occurred_at=f'2026-01-0{day}T00:00:00Z', observed_at=f'2026-01-0{day}T01:00:00Z',"
                " source=policy['trusted_sources'][0], input='test', label='yes') for i in range(count)]\n"
                "    async def artifact(context):\n"
                "        return dict(artifact_version='baseline', configuration_hash='fixed')\n"
                "    async def dataset(context):\n"
                "        return dict(version='1', optimization=rows('o',3,1), validation=rows('v',20,2), audit=rows('a',50,3))\n"
                "    async def propose(data, context):\n"
                "        raise RuntimeError('callback boom')\n"
                "    async def evaluate(data, context):\n"
                "        raise RuntimeError('no')\n"
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
            failed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--once",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(failed.returncode, 0, failed.stderr)
            self.assertIn("callback_failed", failed.stdout)
            self.assertFalse((Path(root) / ".state" / "activation.json").exists())
            again = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--enable",
                    "--once",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("--enable is deprecated and ignored", again.stderr)
            self.assertNotIn("one-time confirmation", again.stderr)
            self.assertIn("callback_failed", again.stdout)

    def test_legacy_stamp_is_ignored_and_left_unchanged(self):
        policy = snake_policy(
            json.loads((ROOT / "python/tests/fixtures/autonomy.json").read_text())["policy"]
        )
        plan = {
            "schemaVersion": 2,
            "language": "python",
            "mode": "autonomous",
            "selfImproving": True,
            "namespace": "app/dev",
            "stepTimeoutMs": 120000,
            "audit": {
                "method": "paired-hoeffding",
                "minimumImprovement": 0.05,
                "range": [0, 1],
                "alpha": 0.05,
                "minimumUnits": 50,
            },
        }
        with tempfile.TemporaryDirectory() as root:
            module = Path(root) / "application.py"
            (Path(root) / "integration-plan.json").write_text(json.dumps(plan))
            module.write_text(
                "import json\nfrom loopiter import FeedbackLoop, InMemoryStore, ImprovementWorkflow\n"
                "async def create_integration(*, cancellation):\n"
                "    loop = FeedbackLoop(store=InMemoryStore(), namespace='cli/legacy')\n"
                f"    policy = json.loads({json.dumps(json.dumps(policy))})\n"
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
            confirmed_at = "2026-01-01T00:00:00.000Z"
            state = Path(root) / ".state"
            state.mkdir()
            (state / "activation.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "entries": {
                            "app/dev": {
                                "planHash": autonomy_plan_hash(plan, "autonomous"),
                                "mode": "autonomous",
                                "confirmedBy": "legacy",
                                "confirmedAt": confirmed_at,
                            }
                        },
                    }
                )
            )
            original = (state / "activation.json").read_text()
            first = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--once",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertNotIn("one-time confirmation", first.stderr)
            self.assertEqual((state / "activation.json").read_text(), original)
            again = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--enable",
                    "--once",
                ],
                cwd=root,
                input="",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("--enable is deprecated and ignored", again.stderr)
            self.assertEqual((state / "activation.json").read_text(), original)

    def test_clearing_a_stamp_surfaces_a_removal_error(self):
        with tempfile.TemporaryDirectory() as root:
            module = Path(root) / "application.py"
            module.write_text("raise RuntimeError('unused')\n")
            (Path(root) / "integration-plan.json").write_text(
                json.dumps({"schemaVersion": 2, "mode": "autonomous", "namespace": "app/dev"})
            )
            record_autonomous_activation(
                module, actor="tester", mode="autonomous", budget_hash="abc"
            )
            state = Path(root) / ".state"
            os.chmod(state, 0o500)
            try:
                with self.assertRaises(OSError):
                    clear_autonomous_activation(module)
            finally:
                os.chmod(state, 0o700)
            stamp = json.loads((state / "activation.json").read_text())
            self.assertEqual(stamp["entries"]["app/dev"]["confirmedBy"], "tester")
            (state / "activation.json").unlink()
            clear_autonomous_activation(module)


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
