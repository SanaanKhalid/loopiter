"""Strict typecheck of with_loopiter. Skips when pyright or mypy is absent."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOOD = textwrap.dedent(
    """
    from typing import Any
    from loopiter.integrations.openai import with_loopiter
    from loopiter.integrations.privacy import CapturePolicy

    class Completions:
        async def create(self, **kwargs: Any) -> dict[str, Any]:
            return {}

    class Chat:
        completions: Completions

    class Responses:
        async def create(self, **kwargs: Any) -> dict[str, Any]:
            return {}

    class Client:
        chat: Chat
        responses: Responses

    def use(client: Client, loop: Any) -> None:
        policy: CapturePolicy = {"mode": "full", "maximum_bytes": 128}
        wrapped = with_loopiter(
            client,
            loop=loop,
            context=lambda _request: {"artifacts": {"prompt": "v1"}},
            capture=policy,
        )
        _ = wrapped.chat.completions
    """
)
BAD = textwrap.dedent(
    """
    from loopiter.integrations.privacy import CapturePolicy

    def bad() -> None:
        wrong_mode: CapturePolicy = {"mode": "everything"}
        unknown_key: CapturePolicy = {"mode": "full", "max_bytes": 1}
        _ = (wrong_mode, unknown_key)
    """
)


class OpenAITypingTests(unittest.TestCase):
    def test_with_loopiter_is_strict_and_capture_keys_are_checked(self) -> None:
        pyright = shutil.which("pyright")
        mypy = shutil.which("mypy")
        if pyright is None or mypy is None:
            self.skipTest("Install pyright and mypy to typecheck with_loopiter")
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            good = folder / "good.py"
            bad = folder / "bad.py"
            good.write_text(GOOD)
            bad.write_text(BAD)
            source = str(ROOT / "python" / "src")
            (folder / "pyrightconfig.json").write_text(
                json.dumps(
                    {
                        "typeCheckingMode": "strict",
                        "extraPaths": [source],
                        "pythonVersion": "3.11",
                    }
                )
            )
            env = {**os.environ, "PYTHONPATH": source}
            for tool, args in (
                (pyright, ["-p", str(folder), str(good)]),
                (mypy, ["--strict", "--follow-imports=silent", str(good)]),
            ):
                result = subprocess.run(
                    [tool, *args], capture_output=True, text=True, env=env, cwd=folder
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for tool, args in (
                (pyright, ["-p", str(folder), str(bad)]),
                (mypy, ["--strict", "--follow-imports=silent", str(bad)]),
            ):
                result = subprocess.run(
                    [tool, *args], capture_output=True, text=True, env=env, cwd=folder
                )
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(sys.version_info >= (3, 11))
