"""Independent-process, simulated controller fixture; no live model calls."""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
from autonomous_registry import PostgresArtifactRegistry
from test_improvement import FIXTURES, dataset

from loopiter import FeedbackLoop, ImprovementController, ImprovementWorkflow
from loopiter.postgres import PostgresStore


async def main():
    from psycopg_pool import AsyncConnectionPool

    namespace, action = sys.argv[1:3]
    async with AsyncConnectionPool(
        os.environ["LOOPITER_PYTHON_TEST_DATABASE_URL"], open=False
    ) as pool:
        policy = FIXTURES["policy"]
        registry = PostgresArtifactRegistry(pool, namespace=namespace, target=policy["target"])
        if action == "init":
            await registry.initialize({"score": 0}, "model-v1")
            print("initialized")
            return
        now = "2026-02-01T02:00:00Z" if action == "observe" else "2026-02-01T00:00:00Z"
        loop = FeedbackLoop(store=PostgresStore(pool), namespace=namespace, clock=lambda: now)

        async def artifact(_):
            c = await registry.current()
            return {"artifact_version": c["version"], "configuration_hash": c["configuration_hash"]}

        async def data(_):
            return dataset()

        async def propose(_, ctx):
            async def call():
                return {"value": [{"score": 1}, {"score": 0.8}], "tokens": 40}

            return await ctx.meter(100, call)

        async def evaluate(i, _):
            return {
                "cases": [
                    {"id": r["id"], "baseline": 0, "candidate": i["change"]["score"]}
                    for r in i["examples"]
                ],
                "metrics": {"errors": 0},
                "estimated_serving_cost": 1,
            }

        async def observe(i, _):
            return {
                "artifact_version": i["artifact_version"],
                "configuration_hash": "model-v1",
                "started_at": i["deployed_at"],
                "ended_at": now,
                "complete": True,
                "unit_ids": [f"production-{n}" for n in range(10)],
                "metrics": {"errors": 0},
            }

        class Deployment:
            async def apply(self, r):
                result = await registry.apply(r)
                if action == "interrupt":
                    raise RuntimeError("INJECTED receipt loss")
                return result

            async def inspect(self, r):
                return await registry.inspect(r)

            async def rollback(self, r):
                return await registry.rollback(r)

        workflow = ImprovementWorkflow(
            id="classification",
            version="1",
            optimizer_version="1",
            evaluator_version="1",
            policy=policy,
            dataset=data,
            artifact=artifact,
            propose=propose,
            evaluate=evaluate,
            deployment=Deployment(),
            observe=observe,
        )
        print(
            json.dumps(
                await ImprovementController(
                    loop, workflows=[workflow], mode="autonomous", self_improving=True
                ).tick("classification")
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
