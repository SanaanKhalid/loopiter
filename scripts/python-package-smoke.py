"""Build, inspect and install real artifacts into clean consumers. Never publishes."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "python"


def python_policy(value):
    if isinstance(value, list):
        return [python_policy(item) for item in value]
    if isinstance(value, dict):
        return {
            re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): child
            if key == "changeSchema"
            else python_policy(child)
            for key, child in value.items()
        }
    return value


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
            assert not any(
                "__pycache__" in name or name.endswith(".pyc") for name in names
            )
            assert "loopiter/py.typed" in names
            assert "loopiter/migrations/001-python-store.sql" in names
            assert "loopiter/migrations/002-autonomy.sql" in names
            assert "loopiter/improvement.py" in names
            assert "loopiter/AGENT_GUIDE.md" in names
            assert "loopiter/onboarding.py" in names
            assert "loopiter/__main__.py" in names
            assert "loopiter/starters/autonomous_demo.py" in names
            assert "loopiter/starters/autonomous_workflows.py" in names
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
from loopiter.onboarding import read_agent_guide, read_reference
assert importlib.util.find_spec('psycopg') is None
assert 'CREATE TABLE' in migration_sql()
assert 'self-hosted SDK/library' in read_agent_guide()
assert 'prompt_workflow' in read_reference('workflows')
asyncio.run(run_store_conformance(InMemoryStore()))
print('Clean consumer capture/conformance/migration smoke passed')
""",
                cwd=work,
            )
            setup = work / f"self-hosted-{index}"
            run(
                str(python),
                "-I",
                "-m",
                "loopiter",
                "init",
                "--directory",
                str(setup),
                cwd=work,
            )
            doctor = subprocess.run(
                [
                    str(python),
                    "-I",
                    "-m",
                    "loopiter",
                    "doctor",
                    "--directory",
                    str(setup),
                ],
                cwd=work,
                check=False,
                capture_output=True,
                text=True,
            )
            assert doctor.returncode == 1 and '"configured": false' in doctor.stdout
            run(str(python), "-I", "-m", "loopiter", "verify", cwd=work)
            run(str(python), "-I", str(setup / "verify.py"), cwd=work)
            policy = python_policy(
                json.loads((PACKAGE / "tests/fixtures/autonomy.json").read_text())[
                    "policy"
                ]
            )
            module = setup / "worker.py"
            marker = setup / "worker-closed"
            module.write_text(f"""
from pathlib import Path
from loopiter import FeedbackLoop, InMemoryStore, ImprovementWorkflow
async def create_integration(*, cancellation):
    loop = FeedbackLoop(store=InMemoryStore(), namespace="installed/worker")
    async def never(*args): raise AssertionError("No evidence: no model calls or deployments permitted")
    async def artifact(context): return dict(artifact_version="baseline", configuration_hash="fixed")
    async def dataset(context): return dict(version="1",optimization=[],validation=[],audit=[])
    class Registry:
        apply = inspect = rollback = never
    async def close():
        await loop.close()
        Path({str(marker)!r}).write_text("closed")
    workflow = ImprovementWorkflow(id="installed-worker",version="1",optimizer_version="1",evaluator_version="1",policy={policy!r},artifact=artifact,dataset=dataset,propose=never,evaluate=never,observe=never,deployment=Registry())
    return dict(loop=loop, workflows=[workflow], close=close)
""")
            tick = subprocess.run(
                [
                    str(python),
                    "-I",
                    "-m",
                    "loopiter",
                    "worker",
                    "--module",
                    str(module),
                    "--enable",
                    "--once",
                ],
                cwd=work,
                check=True,
                capture_output=True,
                text=True,
            )
            assert json.loads(tick.stdout)["state"] == "waiting_for_evidence"
            assert marker.read_text() == "closed"
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
