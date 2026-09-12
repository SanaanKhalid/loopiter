import asyncio
import os
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from test_core import Registry, approved

from loopiter import FeedbackLoop, LoopiterError
from loopiter.postgres import PostgresStore, migration_sql
from loopiter.testing import run_store_conformance

URL = os.environ.get("LOOPITER_PYTHON_TEST_DATABASE_URL")


class FailCommitPostgresStore(PostgresStore):
    armed = False

    @asynccontextmanager
    async def transaction(self, namespace):
        async with super().transaction(namespace) as tx:
            yield tx
            if self.armed:
                page = await tx.list("attempts")
                if any(row["status"] == "succeeded" for row in page["items"]):
                    self.armed = False
                    raise RuntimeError("Injected SQL transaction commit failure")


@unittest.skipUnless(
    URL, "Set LOOPITER_PYTHON_TEST_DATABASE_URL to a disposable PostgreSQL 16/17 DB"
)
class PostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from psycopg import AsyncConnection
        from psycopg.rows import dict_row
        from psycopg_pool import AsyncConnectionPool

        async with await AsyncConnection.connect(URL, autocommit=True) as conn:
            await conn.execute(migration_sql())
        self.pool = AsyncConnectionPool(URL, open=False, kwargs={"row_factory": dict_row})
        self.other_pool = AsyncConnectionPool(URL, open=False)
        await self.pool.open(wait=True)
        await self.other_pool.open(wait=True)
        self.store = PostgresStore(self.pool)
        self.namespace = f"loopiter-python-test/{uuid4()}"
        self.loop = FeedbackLoop(store=self.store, namespace=self.namespace)
        self.other = FeedbackLoop(store=PostgresStore(self.other_pool), namespace=self.namespace)

    async def asyncTearDown(self):
        await self.store.delete_namespace(self.namespace)
        await self.pool.close()
        await self.other_pool.close()

    async def test_conformance(self):
        await run_store_conformance(self.store)

    async def test_independent_clients_revision_race(self):
        await self.loop.record_execution(id="e", kind="prediction")
        outcomes = await asyncio.gather(
            self.loop.complete_execution("e", expected_revision=1, output="a"),
            self.other.complete_execution("e", expected_revision=1, output="b"),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(o, dict) for o in outcomes), 1)
        self.assertEqual(
            sum(isinstance(o, LoopiterError) and o.code == "conflict" for o in outcomes), 1
        )

    async def test_independent_processes_id_race(self):
        async def worker(value):
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                str(Path(__file__).with_name("postgres_worker.py")),
                self.namespace,
                value,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, err = await proc.communicate()
            self.assertEqual(proc.returncode, 0, err.decode())
            return out.decode().strip()

        self.assertEqual(
            sorted(await asyncio.gather(worker("a"), worker("b"))), ["conflict", "inserted"]
        )

    async def test_concurrent_deployment_and_restart_reconciliation(self):
        await approved(self.loop)
        registry = Registry()
        registry.fail = "after"
        outcomes = await asyncio.gather(
            self.loop.deploy_candidate("candidate", registry),
            self.other.deploy_candidate("candidate", registry),
            return_exceptions=True,
        )
        self.assertTrue(all(isinstance(o, LoopiterError) for o in outcomes))
        self.assertEqual(registry.calls, 1)
        pending = (await self.other.list("attempts"))["items"][0]
        self.assertEqual(pending["status"], "pending")
        await self.other.reconcile_deployment(pending["id"], registry)
        self.assertEqual(
            (await self.loop.get_active_candidate({"kind": "prompt", "key": "support"}))["id"],
            "candidate",
        )
        registry.fail = None
        await self.other.rollback_candidate("candidate", registry)
        self.assertIsNone(
            await self.loop.get_active_candidate({"kind": "prompt", "key": "support"})
        )

    async def test_window_query_and_pool_ownership(self):
        await self.loop.record_execution(
            id="old", kind="prediction", started_at="2026-01-01T00:00:00Z"
        )
        await self.loop.record_execution(
            id="new", kind="prediction", started_at="2026-02-01T00:00:00Z"
        )
        page = await self.loop.list("executions", window={"to": "2026-02-01T00:00:00Z"})
        self.assertEqual([r["id"] for r in page["items"]], ["old"])
        await self.loop.close()
        self.assertFalse(self.pool.closed)

    async def test_receipt_transaction_rollback_then_other_client_recovery(self):
        store = FailCommitPostgresStore(self.pool)
        loop = FeedbackLoop(store=store, namespace=self.namespace)
        await approved(loop)
        registry = Registry()
        store.armed = True
        with self.assertRaises(LoopiterError) as error:
            await loop.deploy_candidate("candidate", registry)
        self.assertEqual(error.exception.code, "deployment_pending")
        self.assertEqual((await self.other.get_candidate("candidate"))["status"], "approved")
        self.assertEqual((await self.other.list("attempts"))["items"][0]["status"], "pending")
        await self.other.reconcile_deployment(error.exception.attempt_id, registry)
        self.assertEqual((await self.other.get_candidate("candidate"))["status"], "deployed")


if __name__ == "__main__":
    unittest.main()
