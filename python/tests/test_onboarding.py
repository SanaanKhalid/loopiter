import asyncio
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from loopiter.onboarding import (
    initialize_self_hosted,
    inspect_self_hosted_setup,
    read_agent_guide,
    read_reference,
    run_self_hosted_worker,
    verify_self_hosted_installation,
)

ROOT = Path(__file__).resolve().parents[2]


class OnboardingTests(unittest.TestCase):
    def test_init_preserves_files_and_starts_disabled(self):
        with tempfile.TemporaryDirectory(prefix="loopiter onboarding ") as root:
            destination = Path(root) / "my app"
            result = initialize_self_hosted(destination)
            self.assertFalse(result["connected"])
            self.assertEqual((destination / "AGENT_GUIDE.md").read_text(), read_agent_guide())
            plan = json.loads((destination / "integration-plan.json").read_text())
            self.assertFalse(plan["selfImproving"])
            self.assertEqual(plan["mode"], "recommend")
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
