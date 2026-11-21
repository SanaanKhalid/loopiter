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
import stat
import sys
from pathlib import Path

from . import FeedbackLoop, ImprovementController
from ._validation import fingerprint
from .decision_explain import (
    explain_decision_log,
    format_explanation,
    format_explanation_json,
    format_retention_report,
    format_retention_report_json,
    retention_report_from_state,
)
from .improvement import improvement_work_disabled, warn_ambiguous_improvement_disable
from .improvement_evidence import describe_audit_floor, minimum_certifiable_audit_units

REFERENCES = {
    "workflows": "autonomous_workflows.py",
    "registry": "autonomous_registry.py",
    "providers": "autonomous_provider.py",
    "classification": "reviewed_loop.py",
}
MODES = ("observe", "recommend", "experiment", "autonomous")
MAX_STEP_MS = 7_200_000


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
    if path.exists() and not path.is_file():
        raise ValueError("Integration plan path is not a file.")
    if not path.is_file():
        return None
    plan = json.loads(path.read_text(encoding="utf-8"))
    if type(plan) is not dict:
        raise ValueError("Invalid integration plan.")
    return plan


def read_worker_settings(
    module_path,
    *,
    mode=None,
    mode_source=None,
    step_timeout_ms=None,
    step_timeout_source=None,
    warn_missing_plan=True,
):
    plan = _load_plan(module_path)
    if plan is not None and plan.get("mode") not in MODES:
        raise ValueError("Invalid mode in integration plan.")
    if mode is not None and mode not in MODES:
        raise ValueError("Invalid improvement mode.")
    resolved_mode = mode if mode is not None else (plan or {}).get("mode", "autonomous")
    if resolved_mode not in MODES:
        raise ValueError("Invalid improvement mode.")
    resolved_mode_source = (
        (mode_source or "option")
        if mode is not None
        else "plan"
        if plan and plan.get("mode")
        else "default"
    )
    if plan is None and mode is None and warn_missing_plan:
        print(
            "warning: no integration plan found; falling back to autonomous mode.",
            file=sys.stderr,
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
            "Step timeout must be an integer number of milliseconds from 1 to 7200000."
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
    # Workflow daily limits and callback reservations are stored beside this hash.
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

After doctor reports configured and verify passes, the worker runs by default. An ImprovementController created with no mode is autonomous with self-improving on. The worker runs without --enable. Pass --disable or set LOOPITER_DISABLE=1 to pause before the application module is imported, in every mode, including recommend and experiment. Any non-empty value pauses except 0, false, no, and off. The pause makes no provider call and stores no proposal. It is not mode recommend. Set mode to recommend, or set plan.mode to recommend, to store proposals without applying them. Set mode to observe, or set plan.mode to observe, to inspect evidence without proposing. --enable, --confirm-activation, and --yes are ignored and log a deprecation warning. Validation, audit, minimum improvement, guardrails, trusted sources, budgets, cooldown, the consecutive-failure stop, canary promotion, observation rollback, pause, and lease checks still apply. Autonomous mode fails closed without an audit partition or a budget. Init writes .state/ into a new .gitignore and appends that same pattern to an existing .gitignore without duplicating it.

    python -m loopiter worker --module {shlex.quote(str(Path(directory) / "application.py"))} --once

--mode recommend stores proposals and does not apply a candidate. Set plan.mode to recommend, or run:

    python -m loopiter worker --module {shlex.quote(str(Path(directory) / "application.py"))} --mode recommend --once

The recipe above omits --mode, so plan.mode controls it. Set plan.mode to recommend to turn off autonomous. The --mode flag still overrides the plan. With no integration plan, the worker uses autonomous. Existing schemaVersion 1 plans are left unchanged.

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
            "stepTimeoutMs must be an integer number of milliseconds from 1 to 7200000."
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
    # Import trusted application code on the worker's thread.
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
    self_improving=True,
    once=False,
    interval_ms=30000,
    cancellation=None,
    on_tick=None,
    record_activation=False,
    confirm_budget=None,
):
    if type(self_improving) is not bool:
        raise ValueError("self_improving must be boolean.")
    disabled = self_improving is False or improvement_work_disabled()
    warn_ambiguous_improvement_disable()
    if record_activation or confirm_budget is not None:
        print(
            "warning: activation confirmation is deprecated and ignored. Activation confirmation is no longer required.",
            file=sys.stderr,
        )
    settings = read_worker_settings(
        module_path,
        mode=mode,
        mode_source=mode_source,
        step_timeout_ms=step_timeout_ms,
        step_timeout_source=step_timeout_source,
        warn_missing_plan=not disabled,
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
    if disabled:
        paused = {
            "run_id": None,
            "state": "paused",
            "reason": "self_improvement_disabled",
            "candidate_ids": [],
            "budget": {"model_requests": 0, "tokens": 0, "deployments": 0},
        }
        if on_tick:
            on_tick(paused)
        return [paused]
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
        controller = ImprovementController(
            integration["loop"],
            workflows=integration["workflows"],
            mode=settings["mode"],
            self_improving=self_improving,
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
    raw = sys.argv[1:] if argv is None else list(argv)
    if raw and raw[0] == "eval" and "--help" not in raw and "-h" not in raw:
        from .eval_lock import run_eval_command

        return run_eval_command(raw[1:])
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
        help="Deprecated no-op. Improvement work runs unless --disable or LOOPITER_DISABLE=1 is set.",
    )
    worker.add_argument(
        "--disable",
        action="store_true",
        help="Pause improvement work. Same as LOOPITER_DISABLE=1. Evidence gates stay in place.",
    )
    worker.add_argument(
        "--mode",
        choices=MODES,
        default=None,
        help="Overrides plan.mode. Omit to use the integration plan, or autonomous when no plan is present.",
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
        help="Deprecated no-op. Activation confirmation is no longer required.",
    )
    worker.add_argument(
        "--yes",
        action="store_true",
        help="Deprecated no-op. Same as --confirm-activation.",
    )
    explain = commands.add_parser("explain")
    explain.add_argument("path")
    explain.add_argument("--json", action="store_true")
    commands.add_parser(
        "eval",
        help="Lock an eval set, verify it, or check exact train/eval overlap.",
    ).add_argument("args", nargs=argparse.REMAINDER)
    retention = commands.add_parser("retention")
    retention_commands = retention.add_subparsers(dest="retention_command", required=True)
    retention_status = retention_commands.add_parser("status")
    retention_status.add_argument("--file", required=True)
    retention_status.add_argument("--namespace", required=True)
    retention_status.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "retention":
            report = retention_report_from_state(
                Path(args.file).read_text(encoding="utf-8"), args.namespace
            )
            sys.stdout.write(
                format_retention_report_json(report)
                if args.json
                else format_retention_report(report)
            )
            return 0
        if args.command == "explain":
            explained = explain_decision_log(args.path)
            sys.stdout.write(
                format_explanation_json(explained) if args.json else format_explanation(explained)
            )
            return 0
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
            disabled = args.disable or improvement_work_disabled()
            settings = read_worker_settings(
                args.module,
                mode=args.mode,
                mode_source="flag" if args.mode else None,
                step_timeout_ms=args.step_timeout_ms,
                step_timeout_source="flag" if args.step_timeout_ms is not None else None,
                warn_missing_plan=not disabled,
            )
            if args.enable:
                print(
                    "warning: --enable is deprecated and ignored. Improvement work runs unless --disable is set or LOOPITER_DISABLE is any value other than 0, false, no, or off.",
                    file=sys.stderr,
                )
            if args.confirm_activation:
                print(
                    "warning: --confirm-activation is deprecated and ignored. Activation confirmation is no longer required.",
                    file=sys.stderr,
                )
            if args.yes:
                print(
                    "warning: --yes is deprecated and ignored. Activation confirmation is no longer required.",
                    file=sys.stderr,
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
                        self_improving=not disabled,
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
