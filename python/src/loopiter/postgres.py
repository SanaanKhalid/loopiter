"""Optional psycopg 3 adapter. Importing loopiter does not import a database driver."""

import asyncio
from contextlib import asynccontextmanager
from importlib.resources import files
from typing import TYPE_CHECKING

from . import _validation as v
from .store import page_options

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool


def migration_sql() -> str:
    """Return versioned SQL for the application's migration process; execute explicitly."""
    return "\n".join(
        files("loopiter").joinpath("migrations/" + name).read_text(encoding="utf-8")
        for name in ("001-python-store.sql", "002-autonomy.sql")
    )


class PostgresTransaction:
    def __init__(self, namespace, connection):
        self.namespace, self.connection, self.active = namespace, connection, True
        self.owner = asyncio.current_task()

    def _check(self, kind):
        if not self.active or asyncio.current_task() is not self.owner:
            v.fail("transaction_closed", "Transaction closed or used from a different task.")
        v.enum(kind, v.COLLECTIONS, "collection")

    async def _query(self, sql, params):
        # Use explicit row factory even when the application configures a different default.
        from psycopg.rows import tuple_row

        async with self.connection.cursor(row_factory=tuple_row) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()

    async def get(self, collection, key):
        self._check(collection)
        v.nonempty(key, "id")
        rows = await self._query(
            "SELECT body FROM loopiter_python_records WHERE namespace=%s AND collection=%s AND id=%s",
            (self.namespace, collection, key),
        )
        return rows[0][0] if rows else None

    async def list(self, collection, *, limit=100, cursor=None, window=None):
        self._check(collection)
        page_options(limit, cursor, window)
        window = window or {}
        rows = await self._query(
            "SELECT body FROM loopiter_python_records WHERE namespace=%s AND collection=%s "
            'AND (%s::text IS NULL OR id > %s COLLATE "C") '
            "AND (%s::timestamptz IS NULL OR event_time >= %s::timestamptz) "
            "AND (%s::timestamptz IS NULL OR event_time < %s::timestamptz) ORDER BY id LIMIT %s",
            (
                self.namespace,
                collection,
                cursor,
                cursor,
                window.get("from"),
                window.get("from"),
                window.get("to"),
                window.get("to"),
                limit + 1,
            ),
        )
        result = {"items": [r[0] for r in rows[:limit]]}
        if len(rows) > limit:
            result["next_cursor"] = result["items"][-1]["id"]
        return result

    async def insert(self, collection, record):
        from psycopg.types.json import Jsonb

        self._check(collection)
        v.stored(collection, record, self.namespace)
        if record["revision"] != 1:
            v.fail("conflict", "Insert requires revision 1.")
        rows = await self._query(
            "INSERT INTO loopiter_python_records(namespace,collection,id,revision,event_time,body) "
            "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING id",
            (
                self.namespace,
                collection,
                record["id"],
                1,
                record.get("observed_at", record.get("started_at", record["created_at"])),
                Jsonb(record),
            ),
        )
        if not rows:
            v.fail("conflict", "Record already exists.")

    async def replace(self, collection, record, expected_revision):
        from psycopg.types.json import Jsonb

        self._check(collection)
        v.stored(collection, record, self.namespace)
        v.integer(expected_revision, "expected_revision")
        if collection in ("signals", "events", "observations"):
            v.fail("immutable_record", "Collection is insert-only.")
        if record["revision"] != expected_revision + 1:
            v.fail("conflict", "Replacement revision must increment by one.")
        rows = await self._query(
            "UPDATE loopiter_python_records SET revision=%s, event_time=%s, body=%s "
            "WHERE namespace=%s AND collection=%s AND id=%s AND revision=%s RETURNING id",
            (
                record["revision"],
                record.get("observed_at", record.get("started_at", record["created_at"])),
                Jsonb(record),
                self.namespace,
                collection,
                record["id"],
                expected_revision,
            ),
        )
        if not rows:
            v.fail("conflict", "Revision conflict.")


class PostgresStore:
    """Developer-owned AsyncConnectionPool. Does not migrate or close the supplied pool.

    Namespace advisory locking serializes ALL conforming writers. Use this adapter
    for every write; do not mutate records directly. Separate namespaces can progress
    concurrently. Configure pool timeouts/TLS/DB statement limits in your app.
    """

    version = 2

    def __init__(self, pool: "AsyncConnectionPool"):
        if not callable(getattr(pool, "connection", None)):
            v.fail("invalid_input", "Expected a developer-owned async psycopg pool.")
        self.pool = pool

    @asynccontextmanager
    async def transaction(self, namespace):
        v.nonempty(namespace, "namespace")
        async with self.pool.connection() as connection:
            async with connection.transaction():
                # READ COMMITTED refreshes snapshot after a contended lock is acquired.
                await connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    ("loopiter/python/v1/" + namespace,),
                )
                tx = PostgresTransaction(namespace, connection)
                try:
                    installed = await tx._query(
                        "SELECT to_regclass('loopiter_python_schema_migrations')", ()
                    )
                    if not installed or not installed[0][0]:
                        v.fail(
                            "migration_required",
                            "Database uninitialized. Review and explicitly run migration_sql; construction never changes your schema.",
                        )
                    schema = await tx._query(
                        "SELECT max(version) FROM loopiter_python_schema_migrations", ()
                    )
                    if not schema or schema[0][0] != 2:
                        v.fail(
                            "migration_required",
                            "Store v2 requires explicit SQL migration 002-autonomy.sql. Stop old writers and back up first.",
                        )
                    yield tx
                finally:
                    tx.active = False

    async def delete_namespace(self, namespace):
        async with self.transaction(namespace) as tx:
            await tx.connection.execute(
                "DELETE FROM loopiter_python_records WHERE namespace=%s", (namespace,)
            )

    async def close(self):
        pass  # Application owns the pool's lifecycle.
