"""Application-owned immediate-rollout registry; requires optional psycopg pool.

Execute registry_migration_sql() explicitly. Constructors never perform migrations.
Python owns separate tables and targets from the Node SDK.
"""

from contextlib import asynccontextmanager

from loopiter import _validation as v


def registry_migration_sql():
    return """
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/autonomy-registry/v1',0));
CREATE TABLE IF NOT EXISTS loopiter_python_example_artifacts (
 scope text NOT NULL, version text NOT NULL, artifact jsonb NOT NULL, PRIMARY KEY(scope,version));
CREATE TABLE IF NOT EXISTS loopiter_python_example_targets (
 scope text PRIMARY KEY, version text NOT NULL, configuration_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS loopiter_python_example_receipts (
 scope text NOT NULL, attempt_id text NOT NULL, request_hash text NOT NULL, receipt jsonb,
 PRIMARY KEY(scope,attempt_id));
COMMIT;
"""


class PostgresArtifactRegistry:
    def __init__(self, pool, *, namespace, target):
        v.nonempty(namespace, "namespace")
        v.target(target)
        self.pool, self.namespace, self.target = pool, namespace, dict(target)
        self.scope = v.fingerprint({"namespace": namespace, "target": target})

    @asynccontextmanager
    async def _transaction(self):
        from psycopg.rows import dict_row

        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                    ("loopiter/python/artifact/" + self.scope,),
                )
                async with connection.cursor(row_factory=dict_row) as cursor:
                    yield cursor

    async def initialize(self, artifact, configuration_hash):
        """Explicit initial seed, never an overwrite of a deployed version."""
        from psycopg.types.json import Jsonb

        v.nonempty(configuration_hash, "configuration hash")
        version = v.fingerprint(artifact)
        async with self._transaction() as c:
            await c.execute(
                "SELECT version,configuration_hash FROM loopiter_python_example_targets WHERE scope=%s",
                (self.scope,),
            )
            prior = await c.fetchone()
            if prior:
                if prior["version"] != version or prior["configuration_hash"] != configuration_hash:
                    v.fail("conflict", "Registry already initialized differently.")
                return
            await c.execute(
                "INSERT INTO loopiter_python_example_artifacts VALUES(%s,%s,%s)",
                (self.scope, version, Jsonb(artifact)),
            )
            await c.execute(
                "INSERT INTO loopiter_python_example_targets VALUES(%s,%s,%s)",
                (self.scope, version, configuration_hash),
            )

    async def current(self):
        async with self._transaction() as c:
            await c.execute(
                "SELECT t.version,t.configuration_hash,a.artifact FROM loopiter_python_example_targets t JOIN loopiter_python_example_artifacts a USING(scope,version) WHERE scope=%s",
                (self.scope,),
            )
            row = await c.fetchone()
            if not row:
                v.fail("not_found", "Explicitly initialize the application registry first.")
            return row

    async def get(self, version):
        async with self._transaction() as c:
            await c.execute(
                "SELECT artifact FROM loopiter_python_example_artifacts WHERE scope=%s AND version=%s",
                (self.scope, version),
            )
            row = await c.fetchone()
            if not row:
                v.fail("not_found", "Unknown artifact version.")
            return row["artifact"]

    def _request(self, request):
        candidate, attempt = request["candidate"], request["attempt"]
        if candidate["namespace"] != self.namespace or candidate["target"] != self.target:
            v.fail("forbidden_target", "Registry namespace/target mismatch.")
        if not candidate.get("baseline"):
            v.fail("invalid_input", "Autonomous registry requires a baseline-bound candidate.")
        return v.fingerprint(
            {
                "id": attempt["id"],
                "operation": attempt["operation"],
                "expected": attempt["expected_artifact_version"],
                "restore": attempt.get("restore_artifact_version"),
                "candidate": candidate["content_hash"],
                "configuration": candidate["baseline"]["configuration_hash"],
            }
        )

    async def apply(self, request):
        return await self._change(request, False)

    async def rollback(self, request):
        return await self._change(request, True)

    async def _change(self, request, rollback):
        from psycopg.types.json import Jsonb

        request_hash = self._request(request)
        candidate, attempt = request["candidate"], request["attempt"]
        async with self._transaction() as c:
            await c.execute(
                "SELECT request_hash,receipt FROM loopiter_python_example_receipts WHERE scope=%s AND attempt_id=%s",
                (self.scope, attempt["id"]),
            )
            prior = await c.fetchone()
            if prior:
                if prior["request_hash"] != request_hash:
                    v.fail("conflict", "Idempotency key reused with different request.")
                if not prior["receipt"]:
                    v.fail("fenced", "Inspection fenced this operation.")
                return prior["receipt"]
            await c.execute(
                "SELECT version,configuration_hash FROM loopiter_python_example_targets WHERE scope=%s FOR UPDATE",
                (self.scope,),
            )
            active = await c.fetchone()
            if (
                not active
                or active["version"] != attempt["expected_artifact_version"]
                or active["configuration_hash"] != candidate["baseline"]["configuration_hash"]
            ):
                v.fail("stale_baseline", "Serving artifact/model context changed.")
            version = (
                attempt.get("restore_artifact_version") if rollback else candidate["content_hash"]
            )
            if not version:
                v.fail("not_found", "Missing predecessor.")
            if rollback:
                await c.execute(
                    "SELECT 1 FROM loopiter_python_example_artifacts WHERE scope=%s AND version=%s",
                    (self.scope, version),
                )
                if not await c.fetchone():
                    v.fail("not_found", "Unknown predecessor.")
            else:
                await c.execute(
                    "INSERT INTO loopiter_python_example_artifacts VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                    (self.scope, version, Jsonb(candidate["proposed_change"])),
                )
            receipt = {
                "attempt_id": attempt["id"],
                "artifact_version": version,
                "previous_artifact_version": active["version"],
            }
            await c.execute(
                "UPDATE loopiter_python_example_targets SET version=%s WHERE scope=%s",
                (version, self.scope),
            )
            await c.execute(
                "INSERT INTO loopiter_python_example_receipts VALUES(%s,%s,%s,%s)",
                (self.scope, attempt["id"], request_hash, Jsonb(receipt)),
            )
            return receipt

    async def inspect(self, request):
        request_hash = self._request(request)
        key = request["attempt"]["id"]
        async with self._transaction() as c:
            await c.execute(
                "SELECT request_hash,receipt FROM loopiter_python_example_receipts WHERE scope=%s AND attempt_id=%s",
                (self.scope, key),
            )
            prior = await c.fetchone()
            if prior and prior["request_hash"] != request_hash:
                v.fail("conflict", "Inspection request mismatch.")
            if prior and prior["receipt"]:
                return {"status": "applied", "receipt": prior["receipt"]}
            if not prior:
                await c.execute(
                    "INSERT INTO loopiter_python_example_receipts VALUES(%s,%s,%s,NULL)",
                    (self.scope, key, request_hash),
                )
            return {"status": "not_applied"}
