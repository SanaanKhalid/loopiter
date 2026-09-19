"""Build, inspect and install real artifacts into clean consumers. Never publishes."""

import argparse
import os
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "python"


def run(*args, cwd=ROOT):
    subprocess.run(
        args,
        cwd=cwd,
        check=True,
        env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"},
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        help="Test existing wheel/sdist artifacts without rebuilding them (release gate).",
    )
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="loopiter-package-") as temporary:
        work = Path(temporary)
        artifacts = (
            args.artifacts_dir.resolve() if args.artifacts_dir else work / "artifacts"
        )
        if args.artifacts_dir is None:
            run(sys.executable, "-m", "build", str(PACKAGE), "--outdir", str(artifacts))
        wheels = list(artifacts.glob("*.whl"))
        sdists = list(artifacts.glob("*.tar.gz"))
        if len(wheels) != 1 or len(sdists) != 1:
            raise RuntimeError("Expected exactly one wheel and one source distribution")
        wheel, sdist = wheels[0], sdists[0]
        run(sys.executable, "-m", "twine", "check", str(wheel), str(sdist))
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
            assert "loopiter/py.typed" in names
            assert "loopiter/migrations/001-python-store.sql" in names
            assert "loopiter/migrations/002-autonomy.sql" in names
            assert "loopiter/improvement.py" in names
            metadata = archive.read(
                next(n for n in names if n.endswith("/METADATA"))
            ).decode()
            requirements = [
                line
                for line in metadata.splitlines()
                if line.startswith("Requires-Dist:")
            ]
            assert requirements and all("extra ==" in line for line in requirements), (
                requirements
            )
            assert any(n.endswith("/licenses/LICENSE") for n in names)
        # Test both artifacts, not just an editable checkout. Core import must not need psycopg.
        for index, artifact in enumerate((wheel, sdist)):
            consumer = work / f"consumer-{index}"
            venv.EnvBuilder(with_pip=True).create(consumer)
            python = consumer / (
                "Scripts/python.exe" if os.name == "nt" else "bin/python"
            )
            run(
                str(python),
                "-m",
                "pip",
                "install",
                "--no-deps",
                str(artifact),
                cwd=work,
            )
            run(
                str(python),
                "-I",
                "-c",
                """
import asyncio, importlib.util
from loopiter import FeedbackLoop, InMemoryStore
from loopiter.postgres import migration_sql
from loopiter.testing import run_store_conformance
assert importlib.util.find_spec('psycopg') is None
assert 'CREATE TABLE' in migration_sql()
asyncio.run(run_store_conformance(InMemoryStore()))
print('Clean consumer capture/conformance/migration smoke passed')
""",
                cwd=work,
            )
            run(
                str(python),
                "-I",
                str(PACKAGE / "examples/reviewed_loop.py"),
                "--interrupt",
                cwd=work,
            )
            run(
                str(python),
                "-I",
                "-c",
                """
import asyncio, pathlib, sys, loopiter
assert not pathlib.Path(loopiter.__file__).is_relative_to(pathlib.Path(sys.argv[1]))
# Only application examples are imported from checkout; SDK resolves to the installed artifact.
sys.path.insert(0, sys.argv[2])
from autonomous_demo import run_demo
async def smoke():
    for path, expected in [('accepted', 'completed'), ('regression', 'rolled_back')]:
        report = await run_demo('prompt', path)
        assert report['result']['state'] == expected, report['result']
    print('Installed SDK simulated autonomous cycle and rollback passed')
asyncio.run(smoke())
""",
                str(ROOT),
                str(PACKAGE / "examples"),
                cwd=work,
            )
    print("Python wheel + sdist consumer smoke passed; nothing published.")


if __name__ == "__main__":
    main()
