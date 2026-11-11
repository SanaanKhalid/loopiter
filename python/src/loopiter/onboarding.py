"""Self-hosted setup and a foreground worker. No hosted platform calls or implicit spending."""

import argparse
import asyncio
import getpass
import importlib
import importlib.resources
import importlib.util
import json
import os
import re
import shlex
import signal
import stat
import sys
from datetime import UTC, datetime
from pathlib import Path

from . import FeedbackLoop, ImprovementController
from ._validation import fingerprint
from .improvement_evidence import describe_audit_floor, minimum_certifiable_audit_units

REFERENCES = {
    "workflows": "autonomous_workflows.py",
    "registry": "autonomous_registry.py",
    "providers": "autonomous_provider.py",
    "classification": "reviewed_loop.py",
}
MODES = ("observe", "recommend", "experiment", "autonomous")
MAX_STEP_MS = 3_600_000


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


def _valid_step_timeout(value):
    return type(value) is int and 1 <= value <= MAX_STEP_MS


def _load_plan(module_path):
    path = Path(module_path).resolve().parent / "integration-plan.json"
    if not path.is_file():
        return None
    plan = json.loads(path.read_text(encoding="utf-8"))
    if type(plan) is not dict:
        raise ValueError("Invalid integration plan.")
    return plan


def read_worker_settings(
    module_path, *, mode=None, mode_source=None, step_timeout_ms=None, step_timeout_source=None
):
    plan = _load_plan(module_path)
    if plan is not None and plan.get("mode") not in MODES:
        raise ValueError("Invalid mode in integration plan.")
    if mode is not None and mode not in MODES:
        raise ValueError("Invalid improvement mode.")
    resolved_mode = mode if mode is not None else (plan or {}).get("mode", "recommend")
    if resolved_mode not in MODES:
        raise ValueError("Invalid improvement mode.")
    resolved_mode_source = (
        (mode_source or "option")
        if mode is not None
        else "plan"
        if plan and plan.get("mode")
        else "default"
    )
    if (
        plan is not None
        and "stepTimeoutMs" in plan
        and not _valid_step_timeout(plan["stepTimeoutMs"])
    ):
        raise ValueError("Invalid stepTimeoutMs in integration plan.")
    resolved_timeout = (
        step_timeout_ms
        if step_timeout_ms is not None
        else plan["stepTimeoutMs"]
        if plan is not None and "stepTimeoutMs" in plan
        else 120000
    )
    if not _valid_step_timeout(resolved_timeout):
        raise ValueError(
            "Step timeout must be an integer number of milliseconds from 1 to 3600000."
        )
    resolved_timeout_source = (
        (step_timeout_source or "option")
        if step_timeout_ms is not None
        else "plan"
        if plan is not None and "stepTimeoutMs" in plan
        else "default"
    )
    return {
        "mode": resolved_mode,
        "mode_source": resolved_mode_source,
        "step_timeout_ms": resolved_timeout,
        "step_timeout_source": resolved_timeout_source,
    }


def activation_actor(environment=None):
    environment = os.environ if environment is None else environment
    provided = str(environment.get("LOOPITER_ACTIVATION_ACTOR", "")).strip()
    if provided:
        return provided
    try:
        name = getpass.getuser().strip()
        if name:
            return name
    except Exception:
        pass
    return "unknown"


def effective_namespace(plan, environment=None):
    """LOOPITER_NAMESPACE when set, otherwise the plan namespace."""
    environment = os.environ if environment is None else environment
    provided = str(environment.get("LOOPITER_NAMESPACE", "")).strip()
    if provided:
        return provided
    plan = plan or {}
    namespace = plan.get("namespace")
    return namespace if isinstance(namespace, str) else ""


def autonomy_plan_hash(plan, mode=None, environment=None):
    plan = plan or {}
    step = plan["stepTimeoutMs"] if "stepTimeoutMs" in plan else 120000
    resolved_mode = (
        mode
        if isinstance(mode, str)
        else plan.get("mode")
        if isinstance(plan.get("mode"), str)
        else "recommend"
    )
    # --step-timeout-ms is intentionally absent; the plan's stepTimeoutMs is included.
    return fingerprint(
        {
            "schemaVersion": plan.get("schemaVersion"),
            "mode": resolved_mode,
            "selfImproving": plan.get("selfImproving") is True,
            "namespace": effective_namespace(plan, environment),
            "stepTimeoutMs": step if type(step) is int else None,
            "audit": plan.get("audit"),
            "policy": plan.get("policy"),
            "budget": plan.get("budget"),
        }
    )


def _activation_path(module_path):
    return Path(module_path).resolve().parent / ".state" / "activation.json"


def _activation_entries(module_path):
    path = _activation_path(module_path)
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        entries = parsed.get("entries") if isinstance(parsed, dict) else None
        return entries if isinstance(entries, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def autonomous_activation_current(module_path, mode=None):
    plan = _load_plan(module_path)
    if plan is None:
        return False
    effective_mode = (
        mode
        if isinstance(mode, str)
        else plan.get("mode")
        if isinstance(plan.get("mode"), str)
        else "recommend"
    )
    namespace = effective_namespace(plan)
    stamp = _activation_entries(module_path).get(namespace)
    if not isinstance(stamp, dict):
        return False
    confirmed_by = stamp.get("confirmedBy")
    confirmed_at = stamp.get("confirmedAt")
    return (
        stamp.get("mode") == effective_mode
        and stamp.get("planHash") == autonomy_plan_hash(plan, effective_mode)
        and isinstance(confirmed_by, str)
        and confirmed_by.strip()
        and isinstance(confirmed_at, str)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", confirmed_at)
    )


def record_autonomous_activation(module_path, actor=None, mode=None):
    plan = _load_plan(module_path) or {}
    effective_mode = (
        mode
        if isinstance(mode, str)
        else plan.get("mode")
        if isinstance(plan.get("mode"), str)
        else "recommend"
    )
    namespace = effective_namespace(plan)
    entries = _activation_entries(module_path)
    entries[namespace] = {
        "planHash": autonomy_plan_hash(plan, effective_mode),
        "mode": effective_mode,
        "confirmedBy": (actor or activation_actor()).strip() or "unknown",
        "confirmedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    path = _activation_path(module_path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps({"schemaVersion": 1, "entries": entries}, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def _audit_plan_messages(plan):
    audit = plan.get("audit", None)
    if audit is None:
        if plan.get("mode") != "autonomous":
            return {}
        return {
            "error": (
                "Declare audit sizing. "
                + describe_audit_floor(
                    {"minimum_improvement": 0.05, "range": [0, 1], "alpha": 0.05}
                )
            )
        }
    if type(audit) is not dict:
        raise ValueError("Invalid audit sizing in integration plan.")
    method = audit.get("method", "paired-hoeffding")
    if type(method) is not str or not method.strip():
        raise ValueError("Invalid audit method in integration plan.")
    units = audit.get("minimumUnits")
    if type(units) is not int or units < 1:
        raise ValueError("Invalid audit.minimumUnits in integration plan.")
    if method != "paired-hoeffding":
        return {"warning": "Custom audit method is not sized by the paired Hoeffding check."}
    objective = {
        "minimum_improvement": audit.get("minimumImprovement"),
        "range": audit.get("range"),
        "alpha": audit.get("alpha"),
    }
    try:
        needed = minimum_certifiable_audit_units(objective)
    except Exception as error:
        raise ValueError(str(error) or "Invalid audit objective.") from error
    if units >= needed:
        return {}
    message = f"Audit of {units} units is too small for this objective. " + describe_audit_floor(
        {
            "minimum_improvement": objective["minimum_improvement"],
            "range": objective["range"],
            "alpha": objective["alpha"],
        }
    )
    return {"error": message} if plan.get("mode") == "autonomous" else {"warning": message}


_STATE_IGNORE_LINES = {".state", ".state/", "/.state", "/.state/", "**/.state", "**/.state/"}


def _gitignore_line_covers_state(line):
    trimmed = line.strip()
    if not trimmed or trimmed.startswith("#") or trimmed.startswith("!"):
        return False
    return trimmed in _STATE_IGNORE_LINES


def ensure_state_gitignored(directory):
    """Append `.state/` to an existing setup .gitignore. A second call does not duplicate it."""
    destination = Path(directory)
    try:
        info = destination.lstat()
    except OSError:
        return
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        return
    path = destination / ".gitignore"
    try:
        git_info = path.lstat()
    except OSError:
        return
    if not stat.S_ISREG(git_info.st_mode) or stat.S_ISLNK(git_info.st_mode):
        return
    text = path.read_text(encoding="utf-8")
    if any(_gitignore_line_covers_state(line) for line in text.splitlines()):
        return
    prefix = "" if text.endswith("\n") or text == "" else "\n"
    with path.open("a", encoding="utf-8") as output:
        output.write(f"{prefix}.state/\n")


def initialize_self_hosted(directory):
    # Keep the final component lexical so even a dangling symlink is rejected by mkdir.
    destination = Path(directory).absolute()
    guide = read_agent_guide()
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Never merge with or follow an existing destination/symlink.
    try:
        destination.mkdir(mode=0o700)
    except FileExistsError:
        ensure_state_gitignored(destination)
        raise
    plan = {
        "schemaVersion": 2,
        "language": "python",
        "preset": "autonomous-default",
        "mode": "autonomous",
        "selfImproving": True,
        "stepTimeoutMs": 120000,
        "audit": {
            "method": "paired-hoeffding",
            "minimumImprovement": 0.05,
            "range": [0, 1],
            "alpha": 0.05,
            "minimumUnits": 50,
        },
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

This plan is schemaVersion 2 with preset autonomous-default: mode autonomous and selfImproving true. Doctor still blocks until the reviewed checklist, namespace, durable storage, application module and required environment names are set. verify does not spend or release.

After doctor reports configured and verify passes, autonomous remains the first worker recipe. Before the first run with --enable --mode autonomous, stop and get explicit confirmation from the human. That confirmation is one-time, for initial activation and spend. A completed checklist, doctor report, or plan output alone is not confirmation. After that one confirmation, autonomous runs continue without per-candidate approval.

On a terminal the worker asks you to type activate. When stdin is not a terminal, the first autonomous run passes --confirm-activation or --yes. The worker stores that confirmation in .state/activation.json for this namespace and plan, with who confirmed it and when. The stamp is a consent record, not a security boundary: it is not signed and it is not bound to a machine. Its hash covers the effective mode, self-improving, the effective namespace (LOOPITER_NAMESPACE when set, otherwise the plan namespace), the plan step timeout, audit sizing, and the plan's policy and budget. A one-off --step-timeout-ms is not part of the hash. The stamp records the effective mode that ran. A later run reuses the stamp. A new namespace or a change to those settings asks again. The flag does not bypass audit, budget, or rollback gates. Init writes .state/ into a new .gitignore and appends that same pattern to an existing .gitignore without duplicating it.

    python -m loopiter worker --module {shlex.quote(str(Path(directory) / "application.py"))} --enable --once

--enable authorizes improvement work and provider spending in this process: proposal, replay and judge calls, and, in autonomous mode, a deployment that has passed validation and audit. It does not bypass validation, audit, minimum improvement, guardrails, trusted sources, budgets, cooldown, the consecutive-failure stop, canary promotion, observation rollback, pause, or lease checks. Autonomous mode fails closed without an audit partition, a budget, or --enable. Omit --enable and the worker refuses to start.

--mode recommend stores proposals and does not apply a candidate. Set plan.mode to recommend, or run:

    python -m loopiter worker --module {shlex.quote(str(Path(directory) / "application.py"))} --enable --mode recommend --once

The recipe above omits --mode, so plan.mode controls it. Set plan.mode to recommend to turn off autonomous. The --mode flag still overrides the plan. Constructing ImprovementController without a mode stays on recommend with self-improving off. Existing schemaVersion 1 plans are left unchanged.

One tick advances one durable phase. Omit --once to run a foreground worker; deploy that command with your process manager. A worker does not remain running after its process exits.

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
        "schemaVersion": 2,
        "preset": "autonomous-default",
        "mode": "autonomous",
        "selfImproving": True,
        "connected": False,
        "prompt": f"Read {destination / 'AGENT_GUIDE.md'} and complete the self-hosted SDK integration in this project.",
    }


def inspect_self_hosted_setup(directory, environment=None):
    root = Path(directory).resolve()
    plan = json.loads((root / "integration-plan.json").read_text(encoding="utf-8"))
    if plan.get("schemaVersion") not in (1, 2) or plan.get("language") != "python":
        raise ValueError("Expected a Python self-hosted integration plan, schemaVersion 1 or 2.")
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
    if "stepTimeoutMs" in plan and not _valid_step_timeout(plan["stepTimeoutMs"]):
        raise ValueError(
            "stepTimeoutMs must be an integer number of milliseconds from 1 to 3600000."
        )
    audit = _audit_plan_messages(plan)
    warnings = [audit["warning"]] if audit.get("warning") else []
    if audit.get("error"):
        missing.append(audit["error"])
    return {
        "configured": not missing,
        "liveVerified": False,
        "mode": plan["mode"],
        "selfImproving": plan["selfImproving"],
        "missing": missing,
        "warnings": warnings,
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
    mode=None,
    mode_source=None,
    step_timeout_ms=None,
    step_timeout_source=None,
    self_improving=False,
    once=False,
    interval_ms=30000,
    cancellation=None,
    on_tick=None,
    record_activation=False,
):
    if self_improving is not True:
        raise ValueError(
            "Worker is disabled. Review the setup and pass --enable to permit improvement work and provider spending."
        )
    settings = read_worker_settings(
        module_path,
        mode=mode,
        mode_source=mode_source,
        step_timeout_ms=step_timeout_ms,
        step_timeout_source=step_timeout_source,
    )
    if type(interval_ms) is not int or interval_ms < 1000:
        raise ValueError("Choose a valid mode and an integer interval_ms of at least 1000.")
    print(
        f"effective mode {settings['mode']} (source: {settings['mode_source']})",
        file=sys.stderr,
    )
    print(
        f"effective step timeout {settings['step_timeout_ms']}ms (source: {settings['step_timeout_source']})",
        file=sys.stderr,
    )
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
        for workflow in integration["workflows"]:
            policy = workflow.policy
            if "audit_method" in policy:
                continue
            needed = minimum_certifiable_audit_units(policy["objective"])
            if policy["minimum_audit_units"] >= needed:
                continue
            message = (
                f"Audit size {policy['minimum_audit_units']} is too small for this objective. "
                + describe_audit_floor(policy["objective"])
            )
            if settings["mode"] == "autonomous":
                raise ValueError(message)
            print("warning: " + message, file=sys.stderr)
        if record_activation:
            record_autonomous_activation(module_path, mode=settings["mode"])
        controller = ImprovementController(
            integration["loop"],
            workflows=integration["workflows"],
            mode=settings["mode"],
            self_improving=True,
            step_timeout_ms=settings["step_timeout_ms"],
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
    worker.add_argument(
        "--enable",
        action="store_true",
        help="Authorize improvement work and provider spending. Required before the worker imports application code.",
    )
    worker.add_argument(
        "--mode",
        choices=MODES,
        default=None,
        help="Overrides plan.mode. Omit to use the integration plan, or recommend when no plan is present.",
    )
    worker.add_argument("--once", action="store_true")
    worker.add_argument("--interval-ms", type=int, default=30000)
    worker.add_argument(
        "--step-timeout-ms",
        type=int,
        default=None,
        help="Per-step callback deadline in milliseconds. Overrides plan stepTimeoutMs. Default 120000.",
    )
    worker.add_argument(
        "--confirm-activation",
        action="store_true",
        help=(
            "Record the one-time autonomous confirmation for this namespace and plan. "
            "Later runs reuse it until mode, namespace, audit, policy, or budget changes. "
            "The stamp is a consent record, not a signed or machine-bound check."
        ),
    )
    worker.add_argument(
        "--yes",
        action="store_true",
        help="Same as --confirm-activation.",
    )
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
            settings = read_worker_settings(
                args.module,
                mode=args.mode,
                mode_source="flag" if args.mode else None,
                step_timeout_ms=args.step_timeout_ms,
                step_timeout_source="flag" if args.step_timeout_ms is not None else None,
            )
            granted = bool(args.yes or args.confirm_activation)
            already = settings["mode"] == "autonomous" and autonomous_activation_current(
                args.module, settings["mode"]
            )
            if args.enable and settings["mode"] == "autonomous" and not already and not granted:
                if not sys.stdin.isatty():
                    raise ValueError(
                        "Autonomous activation needs a one-time confirmation for this namespace and plan. "
                        "Pass --confirm-activation or --yes when stdin is not a terminal."
                    )
                print(
                    "Autonomous mode can spend provider budget and deploy a candidate "
                    "that passes validation and audit.",
                    file=sys.stderr,
                )
                answer = input("Type activate to confirm: ")
                if answer.strip() != "activate":
                    raise ValueError("Autonomous activation was not confirmed.")
            record_activation = bool(
                args.enable and settings["mode"] == "autonomous" and (granted or not already)
            )

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
                        mode=settings["mode"],
                        mode_source=settings["mode_source"],
                        step_timeout_ms=settings["step_timeout_ms"],
                        step_timeout_source=settings["step_timeout_source"],
                        self_improving=args.enable,
                        once=args.once,
                        interval_ms=args.interval_ms,
                        cancellation=cancellation,
                        on_tick=lambda result: print(json.dumps(result), flush=True),
                        record_activation=record_activation,
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
