import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
from autonomous_demo import run_demo  # noqa: E402


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_workflows_and_failure_paths(self):
        for kind in ("prompt", "models", "decision"):
            for path in ("accepted", "rejected", "insufficient", "interrupted", "regression"):
                with self.subTest(kind=kind, path=path):
                    report = await run_demo(kind, path)
                    expected = {
                        "rejected": "no_improvement",
                        "insufficient": "waiting_for_evidence",
                        "regression": "rolled_back",
                    }.get(path, "completed")
                    self.assertEqual(report["result"]["state"], expected, report["result"])
                    if path == "accepted":
                        self.assertNotEqual(report["active_version"], report["baseline"])
                    if path == "regression":
                        self.assertEqual(report["active_version"], report["baseline"])
