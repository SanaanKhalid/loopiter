"""Retain measured SIMULATED Python workflow reports. No provider calls or publishing."""

import argparse
import asyncio
import importlib.metadata
import json
import platform
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python/examples"))
from autonomous_demo import run_demo


def comparison(value):
    if not value:
        return None
    cases = value["cases"]
    return {
        "sample_count": len(cases),
        "baseline_mean": sum(row["baseline"] for row in cases) / len(cases),
        "candidate_mean": sum(row["candidate"] for row in cases) / len(cases),
        "metrics": value["metrics"],
        "estimated_serving_cost": value["estimated_serving_cost"],
    }


def summarized(report):
    return {
        **report,
        "validation": {
            cid: comparison(value)
            for cid, value in (report["validation"] or {}).items()
        },
        "audit": comparison(report["audit"]),
    }


async def main(args):
    paths = ("accepted", "rejected", "insufficient", "interrupted", "regression")
    reports = []
    for kind in ("prompt", "models", "decision"):
        for path in paths:
            reports.append(summarized(await run_demo(kind, path)))
    optional = []
    if args.sklearn:
        from sklearn_decision_demo import run_sklearn_demo

        for path in paths:
            optional.append(summarized(await run_sklearn_demo(path)))
    evidence = {
        "generated_at": datetime.now(UTC).isoformat(),
        "release": "0.3.0a1",
        "runtime": platform.python_version(),
        "evidence": "SIMULATED: synthetic labels, in-memory registry, simulated observation clock",
        "injected_failures": [
            "Lost apply receipt",
            "Wrong post-deployment predictions",
        ],
        "live_model_calls": 0,
        "proves_causal_production_improvement": False,
        "workflows": reports,
        "optional_sklearn_version": importlib.metadata.version("scikit-learn")
        if args.sklearn
        else None,
        "optional_sklearn": optional,
    }
    with args.output.open("x") as output:
        json.dump(evidence, output, indent=2)
        output.write("\n")
    print(f"Wrote {len(reports) + len(optional)} simulated reports to {args.output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output", type=Path, help="A new output path; existing reports are preserved"
    )
    parser.add_argument(
        "--sklearn", action="store_true", help="Also exercise the optional ML bridge"
    )
    asyncio.run(main(parser.parse_args()))
