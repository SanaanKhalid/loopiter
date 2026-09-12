import ast
import inspect
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = Path(__file__).resolve().parents[1]


class DocumentationTests(unittest.TestCase):
    def check_examples(self, content, filename):
        examples = re.findall(r"```python\n(.*?)```", content, flags=re.S)
        self.assertGreaterEqual(len(examples), 1, filename)
        for index, code in enumerate(examples):
            ast.parse(code, filename=f"{filename}-snippet-{index}")
            # Complete examples only; receipt is an illustrative fragment with request supplied by adapter.
            if "asyncio.run" in code:
                needs_database = "DATABASE_URL" in code
                database = os.environ.get("LOOPITER_PYTHON_TEST_DATABASE_URL")
                if needs_database and not database:
                    continue
                env = {**os.environ, **({"DATABASE_URL": database} if database else {})}
                namespace = f"loopiter-python-doccheck/{uuid4()}"
                code = code.replace('"support/dev"', repr(namespace))
                try:
                    result = subprocess.run(
                        [sys.executable, "-c", code],
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, f"{filename}: {result.stderr}")
                finally:
                    if needs_database:
                        from psycopg import connect

                        with connect(database) as conn:
                            conn.execute(
                                "DELETE FROM loopiter_python_records WHERE namespace=%s",
                                (namespace,),
                            )

    def test_python_readme_examples(self):
        content = (PACKAGE / "README.md").read_text()
        self.assertGreaterEqual(len(re.findall(r"```python\n", content)), 4)
        self.check_examples(content, "README")
        # The Fern copy must stay aligned; this check also works inside an sdist (no Fern tree).
        fern = ROOT / "fern/pages/python.mdx"
        if fern.exists():
            self.assertEqual(fern.read_text().split("---\n", 2)[2].strip(), content.strip())

    def test_fern_python_reference_and_examples(self):
        pages = ROOT / "fern/pages"
        if not pages.is_dir():
            self.skipTest("Fern pages are outside the Python source distribution")
        for path in sorted(pages.glob("*.mdx")):
            content = path.read_text()
            # The exact quickstart copy is already checked with README above.
            if path.name != "python.mdx" and "```python\n" in content:
                self.check_examples(content, path.name)

        from loopiter import FeedbackLoop

        reference = (pages / "python-api.mdx").read_text()
        methods = re.findall(r"^\| `(\w+)\(", reference, flags=re.M)
        self.assertGreaterEqual(len(methods), 10)
        for method in methods:
            self.assertTrue(
                inspect.iscoroutinefunction(getattr(FeedbackLoop, method, None)),
                f"Documented method must exist and be async: {method}",
            )


if __name__ == "__main__":
    unittest.main()
