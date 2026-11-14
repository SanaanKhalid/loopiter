"""Install the built wheel and sdist, then run the documented onboarding path.

Imports and commands resolve to the venv, not this checkout. No network and no model calls.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import venv
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


def run(python, *args, cwd):
    subprocess.run([str(python), *args], cwd=cwd, check=True)


def files_under(site):
    names = []
    for path in site.rglob("*"):
        if path.is_file():
            names.append(path.relative_to(site).as_posix())
    return names


def check_consumer(python, work, policy, index):
    listed = subprocess.run(
        [
            str(python),
            "-I",
            "-c",
            (
                "import loopiter, pathlib, sys\n"
                "root = pathlib.Path(loopiter.__file__).resolve().parents[1]\n"
                "repo = pathlib.Path(sys.argv[1]).resolve()\n"
                "assert not pathlib.Path(loopiter.__file__).resolve().is_relative_to(repo)\n"
                "print(root)\n"
            ),
            str(ROOT),
        ],
        cwd=work,
        check=True,
        capture_output=True,
        text=True,
    )
    site = Path(listed.stdout.strip())
    present = files_under(site)
    surface = subprocess.run(
        [
            str(python),
            "-I",
            "-c",
            r"""
import importlib.resources, re
from loopiter.onboarding import read_agent_guide
guide = read_agent_guide()
if "self-hosted SDK/library" not in guide:
    raise SystemExit("packed agent guide was not read")
package = importlib.resources.files("loopiter")
if package.joinpath("AGENT_GUIDE.md").read_text(encoding="utf-8") != guide:
    raise SystemExit("setup module did not read the packed agent guide")
links = []
for target in re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", guide):
    if "://" in target or target.startswith("#"):
        continue
    path = target.split("#", 1)[0].split("?", 1)[0]
    if path:
        links.append(path)
if "docs/application-observation.md" not in links:
    raise SystemExit("agent guide does not link to the observation document")
for path in links:
    resource = package.joinpath(*path.split("/"))
    if not resource.is_file():
        raise SystemExit(f"agent guide link does not resolve: {path}")
print("packed python surface ok")
""",
        ],
        cwd=work,
        check=True,
        capture_output=True,
        text=True,
    )
    if surface.returncode != 0:
        raise RuntimeError(surface.stderr)
    help_text = subprocess.run(
        [str(python), "-I", "-m", "loopiter", "--help"],
        cwd=work,
        check=True,
        capture_output=True,
        text=True,
    )
    if "init" not in help_text.stdout:
        raise RuntimeError("python -m loopiter --help did not offer init")
    setup = work / f"setup-{index}"
    run(python, "-I", "-m", "loopiter", "init", "--directory", str(setup), cwd=work)
    if not (setup / "AGENT_GUIDE.md").is_file():
        raise RuntimeError("init did not copy the packed agent guide")
    module = work / f"worker-{index}.py"
    module.write_text(
        "from loopiter import FeedbackLoop, InMemoryStore, ImprovementWorkflow\n"
        f"POLICY = {policy!r}\n"
        "async def create_integration(*, cancellation):\n"
        "    loop = FeedbackLoop(store=InMemoryStore(), namespace='packed/python')\n"
        "    async def never(*_args): raise AssertionError('no model calls')\n"
        "    async def artifact(_context):\n"
        "        return {'artifact_version': 'baseline', 'configuration_hash': 'fixed'}\n"
        "    async def dataset(_context):\n"
        "        return {'version': '1', 'optimization': [], 'validation': [], 'audit': []}\n"
        "    class Registry:\n"
        "        apply = inspect = rollback = never\n"
        "    async def close():\n"
        "        await loop.close()\n"
        "    workflow = ImprovementWorkflow(\n"
        "        id='packed', version='1', optimizer_version='1', evaluator_version='1',\n"
        "        policy=POLICY, artifact=artifact, dataset=dataset, propose=never,\n"
        "        evaluate=never, observe=never, deployment=Registry(),\n"
        "    )\n"
        "    return {'loop': loop, 'workflows': [workflow], 'close': close}\n",
        encoding="utf-8",
    )
    tick = subprocess.run(
        [
            str(python),
            "-I",
            "-m",
            "loopiter",
            "worker",
            "--module",
            str(module),
            "--once",
        ],
        cwd=work,
        check=True,
        capture_output=True,
        text=True,
    )
    state = json.loads(tick.stdout)["state"]
    if state != "waiting_for_evidence":
        raise RuntimeError(f"packed python tick returned {state}")
    return present


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    policy = python_policy(
        json.loads((PACKAGE / "tests/fixtures/autonomy.json").read_text())["policy"]
    )
    with tempfile_dir() as work:
        artifacts = work / "artifacts"
        artifacts.mkdir()
        subprocess.run(
            [sys.executable, "-m", "build", str(PACKAGE), "--outdir", str(artifacts)],
            cwd=ROOT,
            check=True,
            env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"},
        )
        built = [
            ("wheel", next(artifacts.glob("*.whl"))),
            ("sdist", next(artifacts.glob("*.tar.gz"))),
        ]
        reports = []
        for index, (kind, artifact) in enumerate(built):
            consumer = work / f"venv-{index}"
            venv.EnvBuilder(with_pip=True).create(consumer)
            python = consumer / (
                "Scripts/python.exe" if os.name == "nt" else "bin/python"
            )
            if kind == "wheel":
                subprocess.run(
                    [
                        str(python),
                        "-m",
                        "pip",
                        "install",
                        "--no-index",
                        "--no-deps",
                        "--disable-pip-version-check",
                        str(artifact),
                    ],
                    cwd=work,
                    check=True,
                )
            else:
                # The sdist needs hatchling to build. Use the interpreter that
                # already has it, and install the result into this venv. No index.
                site = subprocess.run(
                    [
                        str(python),
                        "-c",
                        "import sysconfig; print(sysconfig.get_paths()['purelib'])",
                    ],
                    cwd=work,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "pip",
                        "install",
                        "--no-index",
                        "--no-deps",
                        "--no-build-isolation",
                        "--disable-pip-version-check",
                        "--target",
                        site,
                        str(artifact),
                    ],
                    cwd=work,
                    check=True,
                )
            reports.append(
                {"kind": kind, "files": check_consumer(python, work, policy, index)}
            )
        args.out.write_text(json.dumps(reports), encoding="utf-8")
    print("Python wheel and sdist onboarding checks passed.")


class tempfile_dir:
    def __enter__(self):
        import tempfile

        self._temp = tempfile.TemporaryDirectory(prefix="loopiter-packed-py-")
        self.path = Path(self._temp.name)
        return self.path

    def __exit__(self, *_args):
        self._temp.cleanup()


if __name__ == "__main__":
    main()
