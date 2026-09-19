import type {
  Collection,
  Collections,
  Page,
  PageOptions,
} from "./contracts.js";
/** Transactions are namespace-bound, serializable, atomic, and unusable after completion.
 * Never call models or deployment adapters inside a transaction callback. */
export interface StoreTransaction {
  get<K extends Collection>(
    collection: K,
    id: string,
  ): Promise<Collections[K] | undefined>;
  list<K extends Collection>(
    collection: K,
    options?: PageOptions,
  ): Promise<Page<Collections[K]>>;
  insert<K extends Collection>(
    collection: K,
    record: Collections[K],
  ): Promise<void>;
  replace<K extends Collection>(
    collection: K,
    record: Collections[K],
    expectedRevision: number,
  ): Promise<void>;
}
export interface FeedbackStore {
  readonly version: 3;
  transaction<T>(
    namespace: string,
    operation: (tx: StoreTransaction) => Promise<T>,
  ): Promise<T>;
  deleteNamespace(namespace: string): Promise<void>;
  close(): Promise<void>;
}
