import type {
  Collection,
  Collections,
  PageOptions,
  RecordBase,
} from "../contracts.js";
import type { FeedbackStore, StoreTransaction } from "../store.js";
import {
  clone,
  fail,
  inWindow,
  integer,
  json,
  nonempty,
  windowValid,
} from "../utils.js";
export type NamespaceState = Partial<{
  [K in Collection]: Record<string, Collections[K]>;
}>;
export type MemoryState = Record<string, NamespaceState>;
export const collections: Collection[] = [
  "executions",
  "signals",
  "candidates",
  "targets",
  "attempts",
  "events",
  "historical",
  "runs", "operations", "budgets", "observations", "coordination",
];
export function validateRecord(namespace: string, record: RecordBase): void {
  json(record, 16 * 1024 * 1024);
  nonempty(record.id, "id");
  integer(record.revision, "revision");
  if (record.namespace !== namespace)
    fail("namespace_mismatch", "Record belongs to another namespace.");
}
export function pageOptions(options: PageOptions = {}): number {
  windowValid(options.window);
  const limit = options.limit ?? 100;
  integer(limit, "page limit");
  if (limit > 1000) fail("query_limit", "Page limit cannot exceed 1000.");
  if (options.cursor !== undefined) nonempty(options.cursor, "cursor");
  return limit;
}
export class InMemoryStore implements FeedbackStore {
  readonly version = 3 as const;
  protected state: MemoryState = Object.create(null) as MemoryState;
  protected pending: Promise<unknown> = Promise.resolve();
  protected async load(): Promise<void> {}
  protected async persist(_next: MemoryState): Promise<void> {}
  protected async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async transaction<T>(
    namespace: string,
    operation: (tx: StoreTransaction) => Promise<T>,
  ): Promise<T> {
    nonempty(namespace, "namespace");
    return this.exclusive(async () => {
      await this.load();
      const state = clone(
        Object.hasOwn(this.state, namespace) ? this.state[namespace] : {},
      ) as NamespaceState;
      let active = true;
      let dirty = false;
      const bucket = <K extends Collection>(
        kind: K,
      ): Record<string, Collections[K]> => {
        if (!active)
          fail("transaction_closed", "Transaction already completed.");
        if (!collections.includes(kind))
          fail("invalid_input", "Invalid collection.");
        return (state[kind] ??= Object.create(null)) as Record<
          string,
          Collections[K]
        >;
      };
      const tx: StoreTransaction = {
        get: async (kind, key) => {
          nonempty(key, "id");
          const b = bucket(kind);
          return Object.hasOwn(b, key) ? clone(b[key]) : undefined;
        },
        list: async (kind, options = {}) => {
          const limit = pageOptions(options);
          const rows = Object.values(bucket(kind))
            .filter(
              (row) =>
                (!options.cursor || row.id > options.cursor) &&
                inWindow(
                  "observedAt" in row
                    ? (row.observedAt as string)
                    : "startedAt" in row
                      ? (row.startedAt as string)
                      : row.createdAt,
                  options.window,
                ),
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return {
            items: clone(rows.slice(0, limit)),
            ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}),
          };
        },
        insert: async (kind, record) => {
          validateRecord(namespace, record);
          const b = bucket(kind);
          if (Object.hasOwn(b, record.id))
            fail("conflict", "Record already exists.");
          if (record.revision !== 1)
            fail("conflict", "Initial revision must be 1.");
          Object.defineProperty(b, record.id, {
            value: clone(record),
            enumerable: true,
            writable: true,
            configurable: true,
          });
          dirty = true;
        },
        replace: async (kind, record, expected) => {
          validateRecord(namespace, record);
          integer(expected, "expectedRevision");
          const b = bucket(kind);
          if (["signals", "events", "historical", "observations"].includes(kind))
            fail("immutable_record", "Collection is insert-only.");
          if (
            !Object.hasOwn(b, record.id) ||
            b[record.id]!.revision !== expected ||
            record.revision !== expected + 1
          )
            fail("conflict", "Revision conflict.");
          b[record.id] = clone(record);
          dirty = true;
        },
      };
      try {
        const result = clone(await operation(tx));
        active = false;
        if (dirty) {
          const next = Object.assign(
            Object.create(null),
            this.state,
          ) as MemoryState;
          Object.defineProperty(next, namespace, {
            value: state,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          await this.persist(next);
          this.state = next;
        }
        return result;
      } finally {
        active = false;
      }
    });
  }
  async deleteNamespace(namespace: string): Promise<void> {
    nonempty(namespace, "namespace");
    await this.exclusive(async () => {
      await this.load();
      const next = clone(this.state);
      delete next[namespace];
      await this.persist(next);
      this.state = next;
    });
  }
  async close(): Promise<void> {
    await this.pending;
  }
}
