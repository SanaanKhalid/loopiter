import asyncio
import os
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from test_core import Registry, approved

from loopiter import FeedbackLoop, LoopiterError
from loopiter.integrations.import_batch import import_batch
from loopiter.postgres import PostgresStore, historical_down_sql, historical_sql, migration_sql
from loopiter.testing import run_store_conformance

URL = os.environ.get("LOOPITER_PYTHON_TEST_DATABASE_URL")

# 002-autonomy.sql as shipped on main, before the superset skip.
_OLD_NARROW_CHECK = """
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check;
ALTER TABLE loopiter_python_records ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination'));
INSERT INTO loopiter_python_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
"""


class HistoricalMigrationSqlTests(unittest.TestCase):
    def test_down_script_is_packaged_outside_migration_sql(self):
        applied = migration_sql()
        upgrade = historical_sql()
        down = historical_down_sql()
        self.assertIn("ADD CONSTRAINT loopiter_python_records_collection_check", applied)
        self.assertNotIn("NOT VALID", applied)
        self.assertIn("LIKE '%historical%'", applied)
        self.assertNotIn(upgrade, applied)
        self.assertIn("NOT VALID", upgrade)
        self.assertIn("VALIDATE CONSTRAINT loopiter_python_records_collection_check", upgrade)
        self.assertIn("SET LOCAL lock_timeout", upgrade)
        self.assertNotIn("VALUES (3)", upgrade)
        self.assertNotIn("refuses to remove them", upgrade)
        self.assertIn("NOT VALID", down)
        self.assertIn("VALIDATE CONSTRAINT", down)
        self.assertIn("LOCK TABLE loopiter_python_records IN SHARE ROW EXCLUSIVE MODE", down)
        self.assertIn("refuses to remove them", down)
        self.assertNotIn(down, applied)
        self.assertNotIn(down, upgrade)


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

    async def test_v2_serves_traffic_and_historical_import_needs_003(self):
        from psycopg import AsyncConnection
        from psycopg.rows import tuple_row

        upgrade = historical_sql()
        body = {
            "idempotencyKey": "ticket-v2",
            "occurredAt": "2026-03-01T15:04:05.123Z",
            "status": "success",
            "stageId": "classify",
            "versions": {"prompt": "support-ticket-v1", "model": "fixture"},
            "usage": {"state": "unknown"},
        }

        async def constraint():
            async with await AsyncConnection.connect(URL) as conn:
                async with conn.cursor(row_factory=tuple_row) as cur:
                    await cur.execute(
                        "SELECT pg_get_constraintdef(oid), convalidated "
                        "FROM pg_constraint WHERE conrelid = %s::regclass AND conname = %s",
                        ("loopiter_python_records", "loopiter_python_records_collection_check"),
                    )
                    definition, validated = await cur.fetchone()
                    await cur.execute("SELECT max(version) FROM loopiter_python_schema_migrations")
                    (version,) = await cur.fetchone()
            return definition, validated, version

        async with await AsyncConnection.connect(URL, autocommit=True) as conn:
            await conn.execute(historical_down_sql())
        try:
            await self.loop.record_execution(id="v2-row", kind="workflow", input={"marker": "kept"})
            saved = await self.loop.get_execution("v2-row")
            self.assertEqual(saved["input"]["marker"], "kept")
            with self.assertRaises(LoopiterError) as caught:
                await import_batch(self.loop, [body])
            self.assertEqual(caught.exception.code, "migration_required")
            self.assertIn("003-historical.sql", str(caught.exception))
            first, second = upgrade.split("\nCOMMIT;\n", 1)
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(first + "\nCOMMIT;\n")
            halfway = await constraint()
            self.assertIn("historical", halfway[0])
            self.assertFalse(halfway[1])
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(upgrade)
            self.assertEqual(
                await import_batch(self.loop, [body]),
                {"accepted": 1, "conflicts": 0, "rejected": 0},
            )
            before = await constraint()
            self.assertIn("historical", before[0])
            self.assertTrue(before[1])
            self.assertEqual(before[2], 2)
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(upgrade)
            self.assertEqual(await constraint(), before)
            await self.store.delete_namespace(self.namespace)
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(historical_down_sql())
            restored, _validated, version = await constraint()
            self.assertNotIn("historical", restored)
            self.assertEqual(version, 2)
            with self.assertRaises(LoopiterError) as again:
                await import_batch(self.loop, [body])
            self.assertEqual(again.exception.code, "migration_required")
            self.assertIn("003-historical.sql", str(again.exception))
        finally:
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(upgrade)

    async def test_migration_sql_keeps_historical_and_old_002_rolls_back(self):
        from psycopg import AsyncConnection
        from psycopg.errors import CheckViolation
        from psycopg.rows import tuple_row

        body = {
            "idempotencyKey": "ticket-keep",
            "occurredAt": "2026-03-01T15:04:05.123Z",
            "status": "success",
            "stageId": "classify",
            "versions": {"prompt": "support-ticket-v1", "model": "fixture"},
            "usage": {"state": "unknown"},
        }

        async def definition():
            async with await AsyncConnection.connect(URL) as conn:
                async with conn.cursor(row_factory=tuple_row) as cur:
                    await cur.execute(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                        "WHERE conrelid = %s::regclass AND conname = %s",
                        ("loopiter_python_records", "loopiter_python_records_collection_check"),
                    )
                    (text,) = await cur.fetchone()
            return text

        try:
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(historical_sql())
            self.assertEqual(
                await import_batch(self.loop, [body]),
                {"accepted": 1, "conflicts": 0, "rejected": 0},
            )
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(migration_sql())
            self.assertIn("historical", await definition())
            self.assertEqual(len((await self.loop.list("historical"))["items"]), 1)
            await self.loop.record_execution(id="still-open", kind="workflow", input={"ok": True})
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                with self.assertRaises(CheckViolation):
                    await conn.execute(_OLD_NARROW_CHECK)
                await conn.rollback()
            self.assertIn("historical", await definition())
            self.assertEqual(len((await self.loop.list("historical"))["items"]), 1)
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(
                    "DELETE FROM loopiter_python_records WHERE collection = 'historical'"
                )
                await conn.execute(_OLD_NARROW_CHECK)
            self.assertNotIn("historical", await definition())
            await self.loop.record_execution(
                id="after-old-002", kind="workflow", input={"ok": True}
            )
            with self.assertRaises(LoopiterError) as caught:
                await import_batch(self.loop, [body])
            self.assertEqual(caught.exception.code, "migration_required")
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(historical_sql())
            self.assertEqual((await import_batch(self.loop, [body]))["accepted"], 1)
            self.assertIn("historical", await definition())
        finally:
            async with await AsyncConnection.connect(URL, autocommit=True) as conn:
                await conn.execute(historical_sql())

    async def test_historical_import(self):
        from psycopg import AsyncConnection

        async with await AsyncConnection.connect(URL, autocommit=True) as conn:
            await conn.execute(historical_sql())
        body = {
            "idempotencyKey": "ticket-pg",
            "occurredAt": "2026-03-01T15:04:05.123Z",
            "status": "success",
            "stageId": "classify",
            "versions": {"prompt": "support-ticket-v1", "model": "fixture"},
            "usage": {"state": "unknown"},
        }
        self.assertEqual(
            await import_batch(self.loop, [body]),
            {"accepted": 1, "conflicts": 0, "rejected": 0},
        )
        stored = (await self.loop.list("historical"))["items"]
        self.assertEqual(stored[0]["original"]["occurredAt"], body["occurredAt"])
        self.assertEqual((await self.loop.list("executions"))["items"], [])

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
