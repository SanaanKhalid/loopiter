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
export { PostgresStore } from "./postgres-store.js";
