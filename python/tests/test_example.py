import contextlib
import importlib.util
import io
import unittest
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "reviewed_loop.py"


class ExampleTests(unittest.IsolatedAsyncioTestCase):
    async def test_accepted_rejected_and_recovered(self):
        spec = importlib.util.spec_from_file_location("reviewed_loop", EXAMPLE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for reject, interrupt in ((False, False), (True, False), (False, True)):
            with (
                self.subTest(reject=reject, interrupt=interrupt),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                report = await module.demo(reject=reject, interrupt=interrupt)
                self.assertEqual(report["mode"], "simulated")
                self.assertEqual(report["gates_passed"], not reject)
                self.assertEqual(report["deployed"], not reject)
                self.assertEqual(report["reconciled"], interrupt)
                if not reject:
                    self.assertEqual(report["prediction_before"], "other")
                    self.assertEqual(report["prediction_after"], "billing")
                    self.assertEqual(report["prediction_after_rollback"], "other")


if __name__ == "__main__":
    unittest.main()
