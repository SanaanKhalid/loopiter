import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
from autonomous_registry import PostgresArtifactRegistry, registry_migration_sql

from loopiter import FeedbackLoop
from loopiter.postgres import PostgresStore, migration_sql


@unittest.skipUnless(
    os.environ.get("LOOPITER_PYTHON_TEST_DATABASE_URL"), "Disposable PostgreSQL required"
)
class AutonomyPostgresTests(unittest.IsolatedAsyncioTestCase):
    async def test_independent_workers_and_recovery(self):
        from psycopg import AsyncConnection
        from psycopg_pool import AsyncConnectionPool

        url = os.environ["LOOPITER_PYTHON_TEST_DATABASE_URL"]
        async with await AsyncConnection.connect(url, autocommit=True) as connection:
            await connection.execute(migration_sql())
            await connection.execute(registry_migration_sql())
        namespace = "autonomy-test/" + str(uuid4())
        async with AsyncConnectionPool(url, open=False) as pool:
            store = PostgresStore(pool)
            loop = FeedbackLoop(store=store, namespace=namespace)
            registry = PostgresArtifactRegistry(
                pool, namespace=namespace, target={"kind": "prompt", "key": "test-classifier"}
            )

            async def worker(action):
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    str(Path(__file__).with_name("autonomy_postgres_worker.py")),
                    namespace,
                    action,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                out, err = await process.communicate()
                self.assertEqual(process.returncode, 0, err.decode())
                return out.decode().strip()

            try:
                await worker("init")
                await asyncio.gather(worker("tick"), worker("tick"))
                self.assertEqual(len((await loop.list("runs"))["items"]), 1)
                self.assertEqual(
                    (await loop.list("budgets"))["items"][0]["data"]["model_requests"], 1
                )
                result = json.loads(await worker("tick"))
                for _ in range(3):
                    if result["state"] == "deploying":
                        break
                    result = json.loads(await worker("tick"))
                self.assertEqual(result["state"], "deploying")
                self.assertEqual(
                    json.loads(await worker("interrupt"))["state"], "reconciliation_required"
                )
                self.assertEqual(json.loads(await worker("tick"))["state"], "observing")
                self.assertEqual(json.loads(await worker("observe"))["state"], "completed")
                candidates = (await loop.list("candidates"))["items"]
                candidate = next(c for c in candidates if c["status"] == "deployed")
                self.assertEqual(candidate["proposed_change"], {"score": 1})
                await loop.rollback_candidate(candidate["id"], registry)
                self.assertEqual((await registry.current())["artifact"], {"score": 0})
            finally:
                await store.delete_namespace(namespace)
                async with pool.connection() as connection:
                    for table in (
                        "loopiter_python_example_receipts",
                        "loopiter_python_example_targets",
                        "loopiter_python_example_artifacts",
                    ):
                        # Constants only; no user-controlled SQL identifiers.
                        await connection.execute(
                            "DELETE FROM " + table + " WHERE scope=%s", (registry.scope,)
                        )
