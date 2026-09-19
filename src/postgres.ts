import { readFile } from "node:fs/promises";
import type { FeedbackStore, StoreTransaction } from "./store.js";
import type { Collection, Collections, RecordBase } from "./contracts.js";
import { clone, fail, integer, nonempty } from "./utils.js";
import {
  collections,
  pageOptions,
  validateRecord,
} from "./stores/in-memory.js";
/** Structural interface: pass your own pg.Pool; loopiter never imports pg. */
export interface PgClientLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
export async function migratePostgres(pool: PgPoolLike): Promise<void> {
  const sql = await readFile(
    new URL("../../migrations/001-feedback-store.sql", import.meta.url),
    "utf8",
  );
  const upgrade = await readFile(new URL("../../migrations/002-autonomy.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(sql);
    await client.query(upgrade);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {
      discard = true;
    });
    throw e;
  } finally {
    client.release(discard);
  }
}
export class PostgresStore implements FeedbackStore {
  readonly version = 3 as const;
  constructor(readonly pool: PgPoolLike) {}
  async transaction<T>(
    namespace: string,
    operation: (tx: StoreTransaction) => Promise<T>,
  ): Promise<T> {
    nonempty(namespace, "namespace");
    const client = await this.pool.connect();
    let discard = false;
    let active = true;
    const check = (collection: Collection) => {
      if (!active) fail("transaction_closed", "Transaction already completed.");
      if (!collections.includes(collection))
        fail("invalid_input", "Invalid collection.");
    };
    const tx: StoreTransaction = {
      get: async <K extends Collection>(kind: K, key: string) => {
        check(kind);
        nonempty(key, "id");
        const result = await client.query(
          "SELECT payload FROM feloop_records WHERE namespace=$1 AND collection=$2 AND id=$3",
          [namespace, kind, key],
        );
        return result.rows[0]?.payload as Collections[K] | undefined;
      },
      list: async <K extends Collection>(kind: K, options = {}) => {
        check(kind);
        const limit = pageOptions(options);
        const o = options as import("./contracts.js").PageOptions;
        const result = await client.query(
          'SELECT payload FROM feloop_records WHERE namespace=$1 AND collection=$2 AND ($3::text IS NULL OR id > $3 COLLATE "C") AND ($4::timestamptz IS NULL OR observed_at >= $4) AND ($5::timestamptz IS NULL OR observed_at < $5) ORDER BY id COLLATE "C" LIMIT $6',
          [
            namespace,
            kind,
            o.cursor ?? null,
            o.window?.from ?? null,
            o.window?.to ?? null,
            limit + 1,
          ],
        );
        const rows = result.rows.map((row) => row.payload as Collections[K]);
        return {
          items: rows.slice(0, limit),
          ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}),
        };
      },
      insert: async (kind, record) => {
        check(kind);
        validateRecord(namespace, record);
        if (record.revision !== 1)
          fail("conflict", "Initial revision must be 1.");
        const result = await client.query(
          "INSERT INTO feloop_records(namespace,collection,id,revision,payload,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [
            namespace,
            kind,
            record.id,
            record.revision,
            JSON.stringify(record),
            recordTime(record),
          ],
        );
        if (result.rowCount !== 1) fail("conflict", "Record already exists.");
      },
      replace: async (kind, record, expected) => {
        check(kind);
        validateRecord(namespace, record);
        integer(expected, "expectedRevision");
        if (["signals", "events", "historical", "observations"].includes(kind))
          fail("immutable_record", "Collection is insert-only.");
        if (record.revision !== expected + 1)
          fail("conflict", "Revision must increment by one.");
        const result = await client.query(
          "UPDATE feloop_records SET revision=$4,payload=$5,observed_at=$6 WHERE namespace=$1 AND collection=$2 AND id=$3 AND revision=$7",
          [
            namespace,
            kind,
            record.id,
            record.revision,
            JSON.stringify(record),
            recordTime(record),
            expected,
          ],
        );
        if (result.rowCount !== 1) fail("conflict", "Revision conflict.");
      },
    };
    try {
      await client.query("BEGIN");
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const installed=await client.query("SELECT to_regclass('feloop_schema_migrations') AS installed");
      if(!installed.rows[0]?.installed)fail('migration_required','Database is uninitialized. Explicitly run migratePostgres after reviewing migrations; construction never changes your schema.');
      const schema=await client.query('SELECT max(version) AS version FROM feloop_schema_migrations');
      if(schema.rows[0]?.version!==2)fail('migration_required','Store v3 requires explicit SQL migration 002-autonomy.sql. Stop old writers and back up first.');
      // Serializes Loopiter writers/read snapshots within a namespace, across processes.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`feloop/v2/${namespace}`],
      );
      const result = clone(await operation(tx));
      active = false;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      active = false;
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      active = false;
      client.release(discard);
    }
  }
  async deleteNamespace(namespace: string): Promise<void> {
    nonempty(namespace, "namespace");
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`feloop/v2/${namespace}`],
      );
      await client.query("DELETE FROM feloop_records WHERE namespace=$1", [
        namespace,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }
  async close(): Promise<void> {
    /* The caller owns the pool and its lifetime. */
  }
}
function recordTime(record: RecordBase): unknown {
  return "observedAt" in record
    ? record.observedAt
    : "startedAt" in record
      ? record.startedAt
      : record.createdAt;
}
