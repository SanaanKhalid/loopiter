import assert from "node:assert/strict";
import test from "node:test";
import {
  FeedbackLoop,
  InMemoryStore,
  importLegacyV1,
  type FeedbackStore,
  type StoreTransaction,
  type DeploymentAdapter,
} from "../src/index.js";
import type { MemoryState } from "../src/stores/in-memory.js";
import { Registry, approved } from "./helpers.js";
import { PostgresStore } from "../src/postgres.js";
const make = () =>
  new FeedbackLoop({ store: new InMemoryStore(), namespace: "test" });

test("failed PostgreSQL rollback discards the checked-out connection", async () => {
  let connections = 0,
    discarded: unknown;
  const store = new PostgresStore({
    connect: async () => {
      connections++;
      return {
        query: async (sql: string) => {
          if (sql === "ROLLBACK") throw new Error("connection lost");
          if(sql.includes('to_regclass'))return {rows:[{installed:'feloop_schema_migrations'}],rowCount:1};
          if(sql.includes('max(version)'))return {rows:[{version:2}],rowCount:1};
          return { rows: [], rowCount: 0 };
        },
        release: (error) => {
          discarded = error;
        },
      };
    },
  });
  await assert.rejects(
    store.transaction("test", async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  assert.equal(connections, 1);
  assert.equal(discarded, true);
});

test("a backwards wall clock cannot corrupt a mutable lifecycle record", async () => {
  let clock = new Date("2026-09-05T00:00:00Z");
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "clock",
    clock: () => clock,
  });
  const candidate = await loop.createCandidate({
    target: { kind: "prompt", key: "x" },
    proposedChange: {},
    evidence: {},
  });
  clock = new Date("2026-09-04T00:00:00Z");
  await loop.evaluateCandidate(
    candidate.id,
    { evaluator: "test", version: "1", datasetHash: "h" },
    () => ({ passed: true }),
  );
  const updated = await loop.getCandidate(candidate.id);
  assert.equal(updated?.status, "evaluated");
  assert.equal(updated?.updatedAt, candidate.updatedAt);
});

test("missing or malformed receipts never release an uncertain reservation", async () => {
  for (const receipt of [
    undefined,
    null,
    {},
    { attemptId: "wrong", artifactVersion: "x", previousArtifactVersion: null },
  ]) {
    const loop = make();
    await approved(loop, "a");
    const adapter: DeploymentAdapter = {
      apply: async () => receipt as never,
      rollback: async () => receipt as never,
      inspect: async () => ({ status: "unknown" }),
    };
    await assert.rejects(loop.deployCandidate("a", { adapter }), /pending/);
    const attempt = (await loop.list("attempts")).items[0]!;
    assert.equal(
      (await loop.reconcileAttempt(attempt.id, adapter)).status,
      "pending",
    );
    await assert.rejects(loop.deployCandidate("a", { adapter }), /Reconcile/);
  }
});
test("late operation after cancellation is fenced by inspect; it cannot apply later", async () => {
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "test",
    callbackTimeoutMs: 10,
  });
  await approved(loop, "a");
  const registry = new Registry();
  let release!: () => void;
  let completion!: Promise<unknown>;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter: DeploymentAdapter = {
    apply: (request) => {
      completion = paused.then(() => registry.apply(request));
      return completion as ReturnType<DeploymentAdapter["apply"]>;
    },
    rollback: (r) => registry.rollback(r),
    inspect: (r) => registry.inspect(r),
  };
  await assert.rejects(loop.deployCandidate("a", { adapter }), /pending/);
  const attempt = (await loop.list("attempts")).items[0]!;
  assert.equal(
    (await loop.reconcileAttempt(attempt.id, adapter)).status,
    "not_applied",
  );
  release();
  await assert.rejects(completion);
  assert.equal(registry.applications, 0);
  assert.equal(
    await loop.getActiveCandidate({ kind: "prompt", key: "chat" }),
    undefined,
  );
});
test("rollback receipt persistence failure restores external state once and reconciles", async () => {
  class Store extends InMemoryStore {
    protected override async persist(state: MemoryState) {
      if (
        this.fail &&
        Object.values(state.test?.attempts ?? {}).some(
          (a) => a.operation === "rollback" && a.status === "succeeded",
        )
      ) {
        this.fail = false;
        throw new Error("injected rollback save failure");
      }
    }
    fail = true;
  }
  const loop = new FeedbackLoop({ store: new Store(), namespace: "test" }),
    registry = new Registry();
  await approved(loop, "a");
  await loop.deployCandidate("a", { adapter: registry });
  await assert.rejects(
    loop.rollbackCandidate("a", { adapter: registry }),
    /pending/,
  );
  const attempt = (await loop.list("attempts")).items.find(
    (a) => a.operation === "rollback",
  )!;
  assert.equal(registry.version, null);
  await loop.reconcileAttempt(attempt.id, registry);
  await assert.rejects(loop.rollbackCandidate("a", { adapter: registry }));
  assert.equal((await loop.getCandidate("a"))?.status, "rolled_back");
});
test("failed transaction before attempt creation never calls external apply", async () => {
  class Store extends InMemoryStore {
    protected override async persist(state: MemoryState) {
      if (Object.keys(state.test?.attempts ?? {}).length)
        throw new Error("injected prepare outage");
    }
  }
  const loop = new FeedbackLoop({ store: new Store(), namespace: "test" }),
    registry = new Registry();
  await approved(loop, "a");
  await assert.rejects(loop.deployCandidate("a", { adapter: registry }));
  assert.equal(registry.applications, 0);
  assert.equal((await loop.list("attempts")).items.length, 0);
});
test("stale evaluation cannot overwrite newer evaluation or its approval", async () => {
  const loop = make();
  const candidate = await loop.createCandidate({
    target: { kind: "prompt", key: "x" },
    proposedChange: {},
    evidence: {},
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    waiting = new Promise<void>((r) => {
      release = r;
    });
  const old = loop.evaluateCandidate(
    candidate.id,
    { evaluator: "test", version: "old", datasetHash: "h" },
    async () => {
      entered();
      await waiting;
      return { passed: true };
    },
  );
  await started;
  const newer = await loop.evaluateCandidate(
    candidate.id,
    { evaluator: "test", version: "new", datasetHash: "h" },
    () => ({ passed: true }),
  );
  const approvals = await Promise.allSettled(
    ["a", "b"].map((actor) =>
      loop.approveCandidate(candidate.id, {
        actor,
        evaluationId: newer.evaluations[0]!.id,
      }),
    ),
  );
  assert.equal(approvals.filter((r) => r.status === "fulfilled").length, 1);
  release();
  await assert.rejects(old, /changed/);
  assert.equal((await loop.getCandidate(candidate.id))?.status, "approved");
});
test("malformed adapter namespace and risk fail closed", async () => {
  const real = new InMemoryStore(),
    loop = new FeedbackLoop({ store: real, namespace: "test" });
  await approved(loop, "a");
  const faulty: FeedbackStore = {
    version: 3,
    close: () => real.close(),
    deleteNamespace: (n) => real.deleteNamespace(n),
    transaction: <T>(n: string, fn: (tx: StoreTransaction) => Promise<T>) =>
      real.transaction(n, (tx) =>
        fn({
          ...tx,
          get: async (kind, id) => {
            const row = await tx.get(kind, id);
            return row ? { ...row, namespace: "another" } : undefined;
          },
        }),
      ),
  };
  const other = new FeedbackLoop({ store: faulty, namespace: "test" });
  await assert.rejects(other.getCandidate("a"), /namespace/);
  for (const result of [
    { passed: "yes" },
    { passed: true, metrics: { score: Infinity } },
  ]) {
    const c = await loop.createCandidate({
      target: { kind: "prompt", key: "x" },
      proposedChange: {},
      evidence: {},
    });
    await assert.rejects(
      loop.evaluateCandidate(
        c.id,
        { evaluator: "test", version: "1", datasetHash: "h" },
        () => result as never,
      ),
    );
  }
});
test("legacy import is idempotent and deployment history never becomes active", async () => {
  const loop = make();
  const legacy = {
    version: 1,
    executions: [{ id: "old", namespace: "test", kind: "turn" }],
    signals: [
      {
        id: "s",
        namespace: "test",
        executionId: "old",
        kind: "rating",
        name: "quality",
        value: true,
        source: "reviewer",
      },
    ],
    candidates: [
      {
        id: "old-deployment",
        namespace: "test",
        status: "deployed",
        proposedChange: "unknown lineage",
      },
    ],
  };
  const original = JSON.stringify(legacy);
  await importLegacyV1(loop, legacy);
  await importLegacyV1(loop, legacy);
  assert.equal(JSON.stringify(legacy), original);
  assert.equal((await loop.list("historical")).items.length, 1);
  assert.equal((await loop.list("targets")).items.length, 0);
});
test("special property names remain ordinary isolated record IDs and namespaces", async () => {
  const store = new InMemoryStore(),
    loop = new FeedbackLoop({ store, namespace: "__proto__" });
  await loop.recordExecution({ id: "__proto__", kind: "turn" });
  assert.equal((await loop.getExecution("__proto__"))?.kind, "turn");
  assert.equal(
    await new FeedbackLoop({ store, namespace: "other" }).getExecution(
      "__proto__",
    ),
    undefined,
  );
});

test("adapter falsy records and malformed pages cannot masquerade as absence", async () => {
  const real = new InMemoryStore();
  for (const result of [false, null, ""]) {
    const faulty: FeedbackStore = {
      version: 3,
      close: () => real.close(),
      deleteNamespace: (n) => real.deleteNamespace(n),
      transaction: <T>(n: string, fn: (tx: StoreTransaction) => Promise<T>) =>
        real.transaction(n, (tx) =>
          fn({
            ...tx,
            get: async () => result as never,
            list: async () => ({ items: null }) as never,
          }),
        ),
    };
    const loop = new FeedbackLoop({ store: faulty, namespace: "test" });
    await assert.rejects(loop.getCandidate("missing"));
    await assert.rejects(loop.list("candidates"));
  }
});

test("evaluation identity is captured before a callback can mutate caller options", async () => {
  const loop = make();
  const candidate = await loop.createCandidate({
    target: { kind: "prompt", key: "x" },
    proposedChange: {},
    evidence: {},
  });
  const context = {
    evaluator: "test",
    version: "original",
    datasetHash: "original-data",
  };
  const result = await loop.evaluateCandidate(candidate.id, context, () => {
    context.version = "changed";
    context.datasetHash = "changed-data";
    return { passed: true };
  });
  assert.equal(result.evaluations[0]!.version, "original");
  assert.equal(result.evaluations[0]!.datasetHash, "original-data");
});

test("unscored or zero-weight activity does not manufacture recurrence", async () => {
  const loop = make();
  await loop.recordExecution({
    id: "e",
    kind: "turn",
    metadata: { task: "one" },
  });
  await loop.recordSignal({
    executionId: "e",
    kind: "rating",
    name: "quality",
    source: "test",
    value: false,
    observedAt: "2026-01-01T00:00:00Z",
  });
  await loop.recordSignal({
    executionId: "e",
    kind: "rating",
    name: "quality",
    source: "test",
    value: false,
    confidence: 0,
    observedAt: "2026-02-01T00:00:00Z",
  });
  await loop.recordSignal({
    executionId: "e",
    kind: "rating",
    name: "quality",
    source: "test",
    value: { unscored: true },
    observedAt: "2026-03-01T00:00:00Z",
  });
  assert.deepEqual(
    await loop.analyze({
      dimensions: ["metadata.task"],
      minimumSupport: 1,
      minimumScoredCount: 1,
      minimumRecurrence: 2,
      minimumEffectSize: 0,
    }),
    [],
  );
});

test("sparse arrays, symbols and accessors are not accepted as plain JSON", async () => {
  const loop = make();
  let accessed = false;
  for (const input of [
    Array(3),
    { [Symbol("hidden")]: "value" },
    {
      get value() {
        accessed = true;
        return "secret";
      },
    },
  ])
    await assert.rejects(
      loop.recordExecution({ kind: "turn", input: input as never }),
    );
  assert.equal(accessed, false);
});
