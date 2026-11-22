"""SQL adapter behavior without a live database.

Live store conformance stays in PostgresTests and runs only when
LOOPITER_PYTHON_TEST_DATABASE_URL points at a disposable database.
Nothing here opens a network connection or creates a server.
"""

import asyncio
import copy
import importlib.util
import unittest
from contextlib import asynccontextmanager

from loopiter import FeedbackLoop, LoopiterError
from loopiter.postgres import PostgresStore, migration_sql
from loopiter.testing import run_store_conformance

PSYCOPG = importlib.util.find_spec("psycopg") is not None


class PostgresMigrationTests(unittest.TestCase):
    def test_packaged_sql_is_readable_without_a_database(self):
        sql = migration_sql()
        self.assertIn("loopiter_python_records", sql)
        self.assertIn("loopiter_python_schema_migrations", sql)
        self.assertIn("CREATE TABLE", sql)


class FakeDatabase:
    def __init__(self):
        self.rows = {}
        self.locks = {}
        self.installed = True
        self.version = 2


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def execute(self, sql, params):
        self.rows = self.connection.handle(sql, params)

    async def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, database):
        self.database = database
        self.snapshot = None
        self.held = None

    def cursor(self, row_factory=None):
        del row_factory
        return FakeCursor(self)

    def rows(self):
        if self.snapshot is None:
            raise AssertionError("SQL ran outside a transaction")
        return self.snapshot

    @asynccontextmanager
    async def transaction(self):
        self.snapshot = copy.deepcopy(self.database.rows)
        try:
            yield
        except BaseException:
            self.snapshot = None
            raise
        else:
            self.database.rows = self.snapshot
            self.snapshot = None
        finally:
            if self.held is not None:
                self.held.release()
                self.held = None

    async def execute(self, sql, params=None):
        if "pg_advisory_xact_lock" in sql:
            lock = self.database.locks.setdefault(params[0], asyncio.Lock())
            await lock.acquire()
            self.held = lock
            self.snapshot = copy.deepcopy(self.database.rows)
        elif "DELETE FROM loopiter_python_records" in sql:
            namespace = params[0]
            self.snapshot = {
                key: value for key, value in self.snapshot.items() if key[0] != namespace
            }

    def handle(self, sql, params):
        compact = " ".join(sql.split())
        if compact.startswith("SELECT to_regclass"):
            name = "loopiter_python_schema_migrations" if self.database.installed else None
            return [(name,)]
        if compact.startswith("SELECT max(version)"):
            return [(self.database.version,)]
        if compact.startswith("SELECT body") and "ORDER BY" in compact:
            return self._list(params)
        if compact.startswith("SELECT body"):
            return self._get(params)
        if compact.startswith("INSERT"):
            return self._insert(params)
        if compact.startswith("UPDATE"):
            return self._replace(params)
        return []

    def _get(self, params):
        namespace, collection, key = params
        row = self.rows().get((namespace, collection, key))
        if row is None:
            return []
        return [(copy.deepcopy(row["body"]),)]

    def _list(self, params):
        namespace, collection, cursor, _, start, _, end, _, limit = params
        selected = []
        for (_namespace, _collection, _key), row in sorted(
            self.rows().items(), key=lambda item: item[1]["body"]["id"]
        ):
            if _namespace != namespace or _collection != collection:
                continue
            identity = row["body"]["id"]
            if cursor is not None and not identity > cursor:
                continue
            when = row["event_time"]
            if start is not None and when < start:
                continue
            if end is not None and when >= end:
                continue
            selected.append((copy.deepcopy(row["body"]),))
            if len(selected) >= limit:
                break
        return selected

    def _insert(self, params):
        namespace, collection, key, revision, event_time, payload = params
        rows = self.rows()
        if (namespace, collection, key) in rows:
            return []
        rows[(namespace, collection, key)] = {
            "revision": revision,
            "event_time": event_time,
            "body": copy.deepcopy(getattr(payload, "obj", payload)),
        }
        return [(key,)]

    def _replace(self, params):
        revision, event_time, payload, namespace, collection, key, expected = params
        row = self.rows().get((namespace, collection, key))
        if row is None or row["revision"] != expected:
            return []
        row["revision"] = revision
        row["event_time"] = event_time
        row["body"] = copy.deepcopy(getattr(payload, "obj", payload))
        return [(key,)]


class FakePool:
    def __init__(self, database):
        self.database = database

    @asynccontextmanager
    async def connection(self):
        yield FakeConnection(self.database)


@unittest.skipUnless(PSYCOPG, "Install loopiter[postgres] to exercise the SQL adapter")
class PostgresAdapterTests(unittest.IsolatedAsyncioTestCase):
    def database(self, **flags):
        database = FakeDatabase()
        for name, value in flags.items():
            setattr(database, name, value)
        return PostgresStore(FakePool(database)), database

    def assert_code(self, caught, code):
        self.assertIsInstance(caught.exception, LoopiterError)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    async def test_conformance_against_fake_driver(self):
        store, _database = self.database()
        await run_store_conformance(store)
        await store.close()

    async def test_constructor_and_migration_failures(self):
        with self.assertRaises(LoopiterError) as caught:
            PostgresStore(object())
        self.assert_code(caught, "invalid_input")
        store, _database = self.database()
        with self.assertRaises(LoopiterError) as caught:
            async with store.transaction("  "):
                pass
        self.assert_code(caught, "invalid_input")
        for flags, message in (
            ({"installed": False}, "uninitialized"),
            ({"version": 1}, "002-autonomy"),
            ({"version": None}, "002-autonomy"),
        ):
            store, _database = self.database(**flags)
            with self.subTest(flags=flags):
                with self.assertRaises(LoopiterError) as caught:
                    async with store.transaction("app"):
                        pass
                error = self.assert_code(caught, "migration_required")
                self.assertIn(message, str(error))

    async def test_transaction_queries_and_conflicts(self):
        store, _database = self.database()
        loop = FeedbackLoop(store=store, namespace="sql")
        await loop.record_execution(id="old", kind="prediction", started_at="2026-01-01T00:00:00Z")
        await loop.record_execution(id="new", kind="prediction", started_at="2026-02-01T00:00:00Z")
        page = await loop.list(
            "executions",
            limit=1,
            window={"from": "2026-01-01T00:00:00Z", "to": "2026-02-01T00:00:00Z"},
        )
        self.assertEqual([row["id"] for row in page["items"]], ["old"])
        self.assertNotIn("next_cursor", page)
        self.assertIsNone(await loop.get_execution("missing"))

        async with store.transaction("sql") as tx:
            leaked = tx
            with self.assertRaises(LoopiterError) as caught:
                await tx.get("not-a-collection", "old")
            self.assert_code(caught, "invalid_input")
            with self.assertRaises(LoopiterError) as caught:
                await tx.get("executions", "")
            self.assert_code(caught, "invalid_input")
            record = await tx.get("executions", "old")
            record["revision"] = 5
            with self.assertRaises(LoopiterError) as caught:
                await tx.insert("executions", record)
            self.assert_code(caught, "conflict")
            record["revision"] = 1
            record["id"] = "old"
            with self.assertRaises(LoopiterError) as caught:
                await tx.insert("executions", record)
            self.assert_code(caught, "conflict")
            replacement = {**record, "id": "old", "revision": 3}
            with self.assertRaises(LoopiterError) as caught:
                await tx.replace("executions", replacement, 1)
            self.assert_code(caught, "conflict")
            replacement["revision"] = 10
            with self.assertRaises(LoopiterError) as caught:
                await tx.replace("executions", replacement, 9)
            self.assert_code(caught, "conflict")
            self.assertIn("Revision conflict", str(caught.exception))

            async def other_task():
                await leaked.get("executions", "old")

            other = asyncio.create_task(other_task())
            with self.assertRaises(LoopiterError) as caught:
                await other
            self.assert_code(caught, "transaction_closed")

        with self.assertRaises(LoopiterError) as caught:
            await leaked.get("executions", "old")
        self.assert_code(caught, "transaction_closed")
        await store.delete_namespace("sql")
        self.assertIsNone(await loop.get_execution("old"))


if __name__ == "__main__":
    unittest.main()
