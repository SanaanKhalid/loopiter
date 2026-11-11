"""Build, inspect and install real artifacts into clean consumers. Never publishes."""

import argparse
import json
import os
import re
import subprocess
import sys
import tarfile
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


def relative_doc_links(guide):
    """Relative markdown targets in AGENT_GUIDE.md. Scheme and anchor-only links are skipped."""
    links = []
    for target in re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", guide):
        if "://" in target or target.startswith("#"):
            continue
        path = target.split("#", 1)[0].split("?", 1)[0]
        if not path:
            continue
        normalized = os.path.normpath(path)
        if (
            path.startswith("/")
            or "\\" in path
            or normalized.startswith("..")
            or os.path.isabs(normalized)
        ):
            raise AssertionError(
                f"AGENT_GUIDE.md link is not a package-relative doc: {target}"
            )
        links.append(normalized.replace(os.sep, "/"))
    if not links:
        raise AssertionError(
            "AGENT_GUIDE.md should link to the packaged observation doc"
        )
    return links


def assert_linked_docs(guide, read_packaged):
    for path in relative_doc_links(guide):
        assert read_packaged(path) == (ROOT / path).read_bytes(), path


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
            assert "loopiter/integrations/openai.py" in names
            assert "loopiter/integrations/context.py" in names
            assert any(n.endswith("/licenses/THIRD_PARTY_NOTICES.md") for n in names)
            assert "loopiter/__main__.py" in names
            assert "loopiter/starters/autonomous_demo.py" in names
            assert "loopiter/starters/autonomous_workflows.py" in names
            guide = archive.read("loopiter/AGENT_GUIDE.md").decode()

            def read_wheel(path, wheel_archive=archive):
                name = "loopiter/" + path
                assert name in names, name
                return wheel_archive.read(name)

            assert_linked_docs(guide, read_wheel)
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
        with tarfile.open(sdist) as sdist_archive:
            sdist_names = sdist_archive.getnames()
            assert any(name.endswith("/hatch_build.py") for name in sdist_names)
            guide_name = next(
                name for name in sdist_names if name.endswith("/AGENT_GUIDE.md")
            )
            guide_file = sdist_archive.extractfile(guide_name)
            assert guide_file is not None
            guide = guide_file.read().decode()

            def read_sdist(path, source_archive=sdist_archive):
                suffix = "/packaged-docs/" + path
                matches = [name for name in sdist_names if name.endswith(suffix)]
                assert len(matches) == 1, matches
                extracted = source_archive.extractfile(matches[0])
                assert extracted is not None
                return extracted.read()

            assert_linked_docs(guide, read_sdist)
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
                r"""
import asyncio, importlib.util
from loopiter import FeedbackLoop, InMemoryStore
from loopiter.postgres import migration_sql
from loopiter.testing import run_store_conformance
from loopiter.onboarding import read_agent_guide, read_reference
assert importlib.util.find_spec('psycopg') is None
assert importlib.util.find_spec('openai') is None
from loopiter.integrations.openai import with_loopiter
from loopiter.integrations.context import replace_guidance, strip_guidance
assert callable(with_loopiter)
assert strip_guidance(replace_guidance('policy', 'guidance')) == 'policy'
assert 'CREATE TABLE' in migration_sql()
assert 'self-hosted SDK/library' in read_agent_guide()
assert 'prompt_workflow' in read_reference('workflows')
import importlib.resources, pathlib, re, sys
repo = pathlib.Path(sys.argv[1])
package = importlib.resources.files('loopiter')
for target in re.findall(r'\[[^\]]*\]\(([^)\s]+)\)', read_agent_guide()):
    if '://' in target or target.startswith('#'):
        continue
    path = target.split('#', 1)[0].split('?', 1)[0]
    resource = package.joinpath(*path.split('/'))
    assert resource.is_file(), path
    assert resource.read_bytes() == (repo / path).read_bytes(), path
asyncio.run(run_store_conformance(InMemoryStore()))
print('Clean consumer capture/conformance/migration smoke passed')
""",
                str(ROOT),
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
                    "--confirm-activation",
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
