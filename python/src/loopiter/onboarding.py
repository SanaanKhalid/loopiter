"""Self-hosted setup and a foreground worker. No hosted platform calls or implicit spending."""

import argparse
import asyncio
import importlib
import importlib.resources
import importlib.util
import json
import os
import re
import shlex
import signal
import sys
from pathlib import Path

from . import FeedbackLoop, ImprovementController

REFERENCES = {
    "workflows": "autonomous_workflows.py",
    "registry": "autonomous_registry.py",
    "providers": "autonomous_provider.py",
    "classification": "reviewed_loop.py",
}
MODES = ("observe", "recommend", "experiment", "autonomous")


def read_agent_guide():
    resource = importlib.resources.files("loopiter").joinpath("AGENT_GUIDE.md")
    if resource.is_file():
        return resource.read_text(encoding="utf-8")
    # Editable source checkout; wheel/sdist consumers use their packaged resource.
    return (Path(__file__).resolve().parents[2] / "AGENT_GUIDE.md").read_text(encoding="utf-8")


def _reference_directory():
    packaged = Path(__file__).resolve().parent / "starters"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[2] / "examples"


def read_reference(name):
    if name not in REFERENCES:
        raise ValueError("Unknown reference. Use: " + ", ".join(REFERENCES))
    return (_reference_directory() / REFERENCES[name]).read_text(encoding="utf-8")


def initialize_self_hosted(directory):
    # Keep the final component lexical so even a dangling symlink is rejected by mkdir.
    destination = Path(directory).absolute()
    guide = read_agent_guide()
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Never merge with or follow an existing destination/symlink.
    destination.mkdir(mode=0o700)
    plan = {
        "schemaVersion": 1,
        "language": "python",
        "mode": "recommend",
        "selfImproving": False,
        "namespace": "",
        "applicationModule": "./application.py",
        "storage": "unconfigured",
        "requiredEnvironment": [],
        "reviewed": dict.fromkeys(
            ("target", "feedback", "evaluation", "budgets", "deployment"), False
        ),
    }
    files = {
        "AGENT_GUIDE.md": guide,
        ".gitignore": ".state/\n.env\n.env.*\n!.env.example\n*.log\n__pycache__/\n",
        "integration-plan.json": json.dumps(plan, indent=2) + "\n",
        "verify.py": "import asyncio, json\nfrom loopiter.onboarding import verify_self_hosted_installation\nprint(json.dumps(asyncio.run(verify_self_hosted_installation()), indent=2))\n",
        "README.md": f"""# Self-hosted Loopiter setup

Give your coding agent this instruction:

> Read AGENT_GUIDE.md in this directory. Inspect my application, propose the integration and feedback placement, and complete the self-hosted SDK setup. Use my infrastructure and model credentials. Verify the integration and explain how to run, pause and roll it back.

Run from the application root:

- python -m loopiter verify — isolated offline controller checks; no credentials or charges.
- python -m loopiter doctor --directory {shlex.quote(str(directory))} — configuration checks, never model calls.
- python -m loopiter reference — installed reference names; no repository clone needed.

Your agent creates application.py here, exporting async create_integration(*, cancellation) returning a dictionary with loop, workflows and optional async close. Connect these to your real serving code, reviewed datasets, evaluator and durable artifact registry. Initialization leaves the plan incomplete and does not claim the application is connected.

After reviewing the plan and verifying the actual integration:

    python -m loopiter worker --module {shlex.quote(str(Path(directory) / "application.py"))} --enable --mode recommend --once

One tick advances one durable phase. Omit --once to run a foreground worker; deploy that command with your process manager. Automatic releases require the explicit --mode autonomous choice and all SDK policy/evidence gates. A worker does not remain running after its process exits.

You pay your selected model/judge, database, retrieval, hosting and logging providers directly. No Loopiter platform login, project key or cloud subscription is needed. See AGENT_GUIDE.md for feedback verification, Jev selection, production storage and recovery.
""",
    }
    for name, contents in files.items():
        path = destination / name
        with path.open("x", encoding="utf-8") as output:
            os.chmod(path, 0o600)
            output.write(contents)
    return {
        "directory": str(destination),
        "files": list(files),
        "mode": "recommend",
        "connected": False,
        "prompt": f"Read {destination / 'AGENT_GUIDE.md'} and complete the self-hosted SDK integration in this project.",
    }


def inspect_self_hosted_setup(directory, environment=None):
    root = Path(directory).resolve()
    plan = json.loads((root / "integration-plan.json").read_text(encoding="utf-8"))
    if plan.get("schemaVersion") != 1 or plan.get("language") != "python":
        raise ValueError("Expected a Python self-hosted integration plan, schemaVersion 1.")
    if plan.get("mode") not in MODES or type(plan.get("selfImproving")) is not bool:
        raise ValueError("Invalid mode or selfImproving in integration plan.")
    module = plan.get("applicationModule")
    if not isinstance(module, str) or not module.strip():
        raise ValueError("Choose a local applicationModule.")
    names = plan.get("requiredEnvironment")
    if not isinstance(names, list) or any(
        not isinstance(n, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", n) for n in names
    ):
        raise ValueError(
            "requiredEnvironment must contain environment-variable names, never values."
        )
    missing = []
    if not isinstance(plan.get("namespace"), str) or not plan["namespace"].strip():
        missing.append("Choose an application-owned namespace.")
    if plan.get("storage") not in ("postgres", "custom-durable"):
        missing.append("Configure durable storage; memory and JSON files are development-only.")
    reviewed = plan.get("reviewed")
    for name in ("target", "feedback", "evaluation", "budgets", "deployment"):
        if not isinstance(reviewed, dict) or reviewed.get(name) is not True:
            missing.append(f"Review {name}.")
    if not (root / module).is_file():
        missing.append("Implement the application integration module.")
    environment = os.environ if environment is None else environment
    for name in names:
        if not environment.get(name):
            missing.append(f"Set {name} through your secret manager or process environment.")
    return {
        "configured": not missing,
        "liveVerified": False,
        "mode": plan["mode"],
        "selfImproving": plan["selfImproving"],
        "missing": missing,
        "note": "Configuration checks only. This does not import application code, contact providers, verify model quality or activate releases.",
    }


async def verify_self_hosted_installation():
    try:
        from .starters.autonomous_demo import run_demo
    except ModuleNotFoundError as error:
        if error.name != "loopiter.starters":
            raise
        # Source-only convenience. Installed verification never needs the checkout.
        original_path = sys.path[:]
        try:
            sys.path.insert(0, str(_reference_directory()))
            from autonomous_demo import run_demo
        finally:
            sys.path[:] = original_path
    expected = {
        "accepted": "completed",
        "rejected": "no_improvement",
        "insufficient": "waiting_for_evidence",
        "interrupted": "completed",
        "regression": "rolled_back",
    }
    checks = []
    for path, state in expected.items():
        report = await run_demo("prompt", path)
        if report["result"]["state"] != state:
            raise RuntimeError(f"Offline {path} check failed: {report['result']['state']}")
        if path == "regression" and report["active_version"] != report["baseline"]:
            raise RuntimeError("Offline rollback did not restore the original artifact.")
        checks.append({"path": path, "state": state, "passed": True})
    return {
        "evidence": "SIMULATED: isolated in-memory fixtures, not live model or application verification",
        "providerCalls": 0,
        "checks": checks,
    }


def _integration_factory(module_path):
    # Import trusted application code on the worker's thread, after explicit enablement.
    path = Path(module_path).resolve()
    spec = importlib.util.spec_from_file_location("_loopiter_application_integration", path)
    if not spec or not spec.loader:
        raise ValueError("--module must name a local Python integration file.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    factory = getattr(module, "create_integration", None)
    if not callable(factory):
        raise ValueError("The local module must export async create_integration(*, cancellation).")
    return factory


async def run_self_hosted_worker(
    module_path,
    *,
    mode="recommend",
    self_improving=False,
    once=False,
    interval_ms=30000,
    cancellation=None,
    on_tick=None,
):
    if self_improving is not True:
        raise ValueError(
            "Worker is disabled. Review the setup and pass --enable to permit improvement work and provider spending."
        )
    if mode not in MODES or type(interval_ms) is not int or interval_ms < 1000:
        raise ValueError("Choose a valid mode and an integer interval_ms of at least 1000.")
    cancellation = cancellation if cancellation is not None else asyncio.Event()
    if cancellation.is_set():
        raise asyncio.CancelledError
    factory = _integration_factory(module_path)
    integration = await factory(cancellation=cancellation)
    try:
        if (
            not isinstance(integration, dict)
            or not isinstance(integration.get("loop"), FeedbackLoop)
            or not isinstance(integration.get("workflows"), list)
        ):
            raise ValueError(
                "create_integration must return a dictionary with loop, workflows and optional async close."
            )
        controller = ImprovementController(
            integration["loop"], workflows=integration["workflows"], mode=mode, self_improving=True
        )
        results = []
        while not cancellation.is_set():
            for workflow in integration["workflows"]:
                if cancellation.is_set():
                    break
                result = await controller.tick(workflow.id, cancellation)
                if once:
                    results.append(result)
                if on_tick:
                    on_tick(result)
            if once or cancellation.is_set():
                break
            try:
                await asyncio.wait_for(cancellation.wait(), interval_ms / 1000)
            except TimeoutError:
                pass
        return results
    finally:
        if isinstance(integration, dict):
            if integration.get("close"):
                await integration["close"]()
            elif isinstance(integration.get("loop"), FeedbackLoop):
                await integration["loop"].close()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Loopiter self-hosted SDK tools; no platform account required."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("guide", "verify"):
        commands.add_parser(name)
    for name in ("init", "doctor"):
        commands.add_parser(name).add_argument("--directory", default="loopiter")
    commands.add_parser("reference").add_argument("--name", choices=tuple(REFERENCES))
    worker = commands.add_parser("worker")
    worker.add_argument("--module", required=True)
    worker.add_argument("--enable", action="store_true")
    worker.add_argument("--mode", choices=MODES, default="recommend")
    worker.add_argument("--once", action="store_true")
    worker.add_argument("--interval-ms", type=int, default=30000)
    args = parser.parse_args(argv)
    try:
        if args.command == "guide":
            print(read_agent_guide(), end="")
            return 0
        if args.command == "reference":
            print(read_reference(args.name) if args.name else "\n".join(REFERENCES))
            return 0
        if args.command == "init":
            report = initialize_self_hosted(args.directory)
        elif args.command == "doctor":
            report = inspect_self_hosted_setup(args.directory)
        elif args.command == "verify":
            report = asyncio.run(verify_self_hosted_installation())
        else:

            async def run():
                cancellation = asyncio.Event()
                event_loop = asyncio.get_running_loop()
                installed = []
                for signum in (signal.SIGINT, signal.SIGTERM):
                    try:
                        event_loop.add_signal_handler(signum, cancellation.set)
                        installed.append(signum)
                    except NotImplementedError:
                        pass
                try:
                    await run_self_hosted_worker(
                        args.module,
                        mode=args.mode,
                        self_improving=args.enable,
                        once=args.once,
                        interval_ms=args.interval_ms,
                        cancellation=cancellation,
                        on_tick=lambda result: print(json.dumps(result), flush=True),
                    )
                finally:
                    for signum in installed:
                        event_loop.remove_signal_handler(signum)

            asyncio.run(run())
            return 0
        print(json.dumps(report, indent=2))
        return int(args.command == "doctor" and not report["configured"])
    except (Exception, KeyboardInterrupt) as error:
        print(str(error) if str(error) else "Worker interrupted.", file=sys.stderr)
        return 1
