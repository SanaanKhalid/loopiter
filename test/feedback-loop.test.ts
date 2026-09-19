import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FeedbackLoop,
  InMemoryStore,
  JsonFileStore,
  migrateJsonV2,
  type CreateCandidateInput,
} from "../src/index.js";
import type { MemoryState } from "../src/stores/in-memory.js";
import { runStoreConformance } from "../src/testing.js";
import { Registry, approved, seed, analysis } from "./helpers.js";
const make = () =>
  new FeedbackLoop({ store: new InMemoryStore(), namespace: "test" });
test("in-memory adapter conformance", async () => {
  assert.equal((await runStoreConformance(new InMemoryStore())).length, 9);
});
test("JSON conformance and reopen persistence", async () => {
  const path = await mkdtemp(join(tmpdir(), "loopiter-json-"));
  const file = join(path, "state.json");
  const store = new JsonFileStore(file);
  try {
    await runStoreConformance(store);
    const loop = new FeedbackLoop({ store, namespace: "saved" });
    await loop.recordExecution({ id: "persisted", kind: "turn" });
    await store.close();
    const next = new JsonFileStore(file);
    assert.ok(
      await new FeedbackLoop({ store: next, namespace: "saved" }).getExecution(
        "persisted",
      ),
    );
    await next.close();
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 3);
  } finally {
    await store.close();
    await rm(path, { recursive: true, force: true });
  }
});
test('copy-only JSON migration preserves active receipts and valid rollback lineage',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'loopiter-migration-')),source=join(temporary,'v2.json'),destination=join(temporary,'v3.json');
  const old=new JsonFileStore(source),registry=new Registry();
  try{
    const loop=new FeedbackLoop({store:old,namespace:'legacy'});await approved(loop,'legacy-candidate');await loop.deployCandidate('legacy-candidate',{adapter:registry});await old.close();
    const data=JSON.parse(await readFile(source,'utf8'));data.version=2;
    for(const buckets of Object.values(data.namespaces) as Record<string,unknown>[])for(const name of ['runs','operations','budgets','observations','coordination'])delete buckets[name];
    await writeFile(source,JSON.stringify(data));const original=await readFile(source,'utf8');
    await assert.rejects(migrateJsonV2(source,source));await migrateJsonV2(source,destination);
    await assert.rejects(migrateJsonV2(source,destination));assert.equal(await readFile(source,'utf8'),original);
    const upgraded=new JsonFileStore(destination);
    try{const next=new FeedbackLoop({store:upgraded,namespace:'legacy'});assert.equal((await next.getCandidate('legacy-candidate'))?.status,'deployed');await next.rollbackCandidate('legacy-candidate',{adapter:registry});assert.equal(registry.version,null);assert.equal((await next.list('runs')).items.length,0);}finally{await upgraded.close();}
  }finally{await old.close();await rm(temporary,{recursive:true,force:true});}
});
test("IDs cannot overwrite another namespace and conflicting input is rejected", async () => {
  const store = new InMemoryStore(),
    a = new FeedbackLoop({ store, namespace: "a" }),
    b = new FeedbackLoop({ store, namespace: "b" });
  await a.recordExecution({ id: "shared", kind: "turn" });
  await b.recordExecution({ id: "shared", kind: "tool" });
  assert.equal((await a.getExecution("shared"))?.kind, "turn");
  await assert.rejects(a.recordExecution({ id: "shared", kind: "prediction" }));
});
test("runtime validation rejects malformed risk, dates, JSON and old unscoped inputs", async () => {
  const loop = make();
  await assert.rejects(
    loop.createCandidate({
      target: { kind: "prompt", key: "x" },
      proposedChange: {},
      evidence: {},
      risk: "LOW",
    } as unknown as CreateCandidateInput),
  );
  for (const startedAt of ["invalid", "2026-02-30T00:00:00Z"])
    await assert.rejects(loop.recordExecution({ kind: "turn", startedAt }));
  await assert.rejects(loop.recordExecution({ kind: "turn", input: NaN }));
  await assert.rejects(
    loop.recordExecution({ kind: "turn", namespace: "wrong" } as never),
  );
  await assert.rejects(
    loop.recordSignal({
      kind: "rating",
      name: "x",
      source: "test",
      value: 1,
      executionId: "absent",
    }),
  );
});
test("sanitization runs before persistence and failures never fall through", async () => {
  const store = new InMemoryStore();
  const bad = new FeedbackLoop({
    store,
    namespace: "x",
    sanitize: () => {
      throw new Error("redaction unavailable");
    },
  });
  await assert.rejects(bad.recordExecution({ kind: "turn" }));
  assert.equal((await bad.list("executions")).items.length, 0);
  const good = new FeedbackLoop({
    store,
    namespace: "x",
    sanitize: (value) => ({ ...(value as object), input: "[redacted]" }),
  });
  assert.equal(
    (await good.recordExecution({ kind: "turn", input: "secret" })).input,
    "[redacted]",
  );
  const small = new FeedbackLoop({
    store,
    namespace: "x",
    maximumPayloadBytes: 40,
  });
  await assert.rejects(
    small.recordExecution({ kind: "turn", input: "x".repeat(100) }),
  );
});
test("concurrent deployments cannot leave two active candidates", async () => {
  const loop = make(),
    adapter = new Registry();
  await approved(loop, "a");
  await approved(loop, "b");
  const results = await Promise.allSettled([
    loop.deployCandidate("a", { adapter }),
    loop.deployCandidate("b", { adapter }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await loop.list("candidates")).items.filter((c) => c.status === "deployed")
      .length,
    1,
  );
  assert.equal(adapter.applications, 1);
});
test("repeated rollback follows A <- B <- C and never restores rolled-back C", async () => {
  const loop = make(),
    adapter = new Registry();
  for (const key of ["a", "b", "c"]) {
    await approved(loop, key);
    await loop.deployCandidate(key, { adapter });
  }
  await loop.rollbackCandidate("c", { adapter });
  assert.equal(
    (await loop.getActiveCandidate({ kind: "prompt", key: "chat" }))?.id,
    "b",
  );
  await loop.rollbackCandidate("b", { adapter });
  assert.equal(
    (await loop.getActiveCandidate({ kind: "prompt", key: "chat" }))?.id,
    "a",
  );
  assert.equal((await loop.getCandidate("c"))?.status, "rolled_back");
  await loop.rollbackCandidate("a", { adapter });
  assert.equal(adapter.version, null);
  assert.equal(
    await loop.getActiveCandidate({ kind: "prompt", key: "chat" }),
    undefined,
  );
});
test("late evaluation cannot overwrite a human rejection", async () => {
  const loop = make();
  const c = await loop.createCandidate({
    target: { kind: "prompt", key: "chat" },
    proposedChange: {},
    evidence: {},
  });
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const start = new Promise<void>((r) => {
    entered = r;
  });
  const evaluation = loop.evaluateCandidate(
    c.id,
    { evaluator: "test", version: "1", datasetHash: "h" },
    async () => {
      entered();
      await pending;
      return { passed: true };
    },
  );
  await start;
  await loop.rejectCandidate(c.id, "human rejected");
  release();
  await assert.rejects(evaluation, /changed/);
  assert.equal((await loop.getCandidate(c.id))?.status, "rejected");
});
test("approval is bound to latest evaluation and concurrent approval conflicts", async () => {
  const loop = make();
  const c = await approved(loop, "a");
  await assert.rejects(
    loop.approveCandidate(c.id, {
      actor: "other",
      evaluationId: c.evaluations[0]!.id,
    }),
  );
  await assert.rejects(
    loop.evaluateCandidate(
      c.id,
      { evaluator: "test", version: "2", datasetHash: "h" },
      () => ({ passed: true }),
    ),
  );
});
test("persistence failure after apply reconciles without applying twice", async () => {
  class FailingStore extends InMemoryStore {
    failOnce = true;
    protected override async persist(next: MemoryState) {
      if (
        this.failOnce &&
        Object.values(next.test?.attempts ?? {}).some(
          (a) => a.status === "succeeded",
        )
      ) {
        this.failOnce = false;
        throw new Error("disk failure");
      }
    }
  }
  const loop = new FeedbackLoop({
      store: new FailingStore(),
      namespace: "test",
    }),
    adapter = new Registry();
  await approved(loop, "a");
  await assert.rejects(loop.deployCandidate("a", { adapter }), /pending/);
  const attempt = (await loop.list("attempts")).items[0]!;
  assert.equal(attempt.status, "pending");
  await assert.rejects(loop.deployCandidate("a", { adapter }));
  await loop.reconcileAttempt(attempt.id, adapter);
  assert.equal(adapter.applications, 1);
  assert.equal((await loop.getCandidate("a"))?.status, "deployed");
});
test("zero-confidence signals cannot pass effect or support thresholds", async () => {
  const loop = make();
  await seed(loop, 0);
  assert.deepEqual(await loop.analyze(analysis), []);
});
test("one episode outcome remains one scored unit, not five independent outcomes", async () => {
  const loop = make();
  for (let i = 0; i < 5; i++)
    await loop.recordExecution({
      kind: "turn",
      episodeId: "one",
      metadata: { segment: "one" },
    });
  await loop.recordSignal({
    kind: "outcome",
    episodeId: "one",
    name: "resolved",
    value: false,
    source: "test",
  });
  assert.deepEqual(
    await loop.analyze({
      ...analysis,
      minimumSupport: 1,
      minimumScoredCount: 5,
      minimumEffectSize: 0,
    }),
    [],
  );
  const [f] = await loop.analyze({
    ...analysis,
    minimumSupport: 1,
    minimumScoredCount: 1,
    minimumEffectSize: 0,
  });
  assert.equal(f!.uniqueSignalCount, 1);
  assert.equal(f!.scoredCount, 1);
  assert.equal(f!.episodeCount, 1);
});
test("late outcomes are included independently of execution cohort dates", async () => {
  const loop = make();
  const e = await loop.recordExecution({
    kind: "turn",
    startedAt: "2026-01-01T00:00:00Z",
    metadata: { segment: "old" },
  });
  await loop.recordSignal({
    executionId: e.id,
    kind: "outcome",
    name: "resolved",
    value: false,
    source: "test",
    observedAt: "2026-02-01T00:00:00Z",
  });
  const findings = await loop.analyze({
    ...analysis,
    observationWindow: {
      from: "2026-02-01T00:00:00Z",
      to: "2026-02-02T00:00:00Z",
    },
    minimumSupport: 1,
    minimumScoredCount: 1,
    minimumEffectSize: 0,
  });
  assert.equal(findings.length, 1);
});
test("analysis limits and invalid score callbacks fail explicitly", async () => {
  const loop = make();
  await seed(loop);
  await assert.rejects(
    loop.analyze({ ...analysis, maximumRecords: 2 }),
    /exceeds/,
  );
  await assert.rejects(loop.analyze({ ...analysis, score: () => NaN }));
});
test("new evidence changes manifest fingerprint; confidence output is absent", async () => {
  const loop = make();
  await seed(loop);
  const before = (await loop.analyze(analysis))[0]!;
  await loop.recordSignal({
    executionId: "e0",
    kind: "correction",
    name: "correct",
    value: false,
    correction: "corrected",
    source: "operator",
  });
  const after = (await loop.analyze(analysis))[0]!;
  assert.notEqual(before.evidence.fingerprint, after.evidence.fingerprint);
  assert.equal("confidence" in after, false);
});
