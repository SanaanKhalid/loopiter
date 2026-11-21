import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FeedbackLoop,
  InMemoryStore,
  LoopiterError,
  servedAnswerId,
  type JsonObject,
} from "../src/index.js";
import {
  feedbackCursorId,
  feedbackHeadId,
  feedbackInput,
  feedbackRecordId,
  persistFeedback,
  promoteFeedbackCursor,
  readFeedbackHead,
  rewindPromotedCursor,
  targetScope,
} from "../src/feedback.js";
import { admitModelCall, capBlock } from "../src/run-caps.js";
import type { StoreTransaction } from "../src/store.js";
import { fail } from "../src/utils.js";
import { Registry, approved } from "./helpers.js";

const served = JSON.parse(
  await readFile(new URL("../../test/fixtures/served-answer.json", import.meta.url), "utf8"),
) as {
  cases: { input: Record<string, string>; id: string }[];
  feedback: { input: Record<string, unknown>; id: string }[];
  text: { field: string; unit?: string; accept?: number; reject?: number | boolean; text?: string }[];
};

const NOW = "2026-01-15T12:00:00.000Z";
const target = { kind: "prompt", key: "classifier" };

function loopWith(store: InMemoryStore) {
  return new FeedbackLoop({ store, namespace: "app", clock: () => new Date(NOW) });
}

test("served answer ids and feedback ids match the shared fixture", () => {
  for (const item of served.cases) assert.equal(servedAnswerId(item.input), item.id);
  assert.notEqual(served.cases[0]!.id, served.cases[1]!.id);
  assert.notEqual(served.cases[2]!.id, served.cases[3]!.id);
  for (const item of served.feedback)
    assert.equal(feedbackRecordId(feedbackInput(item.input)), item.id);
});

test("served answer ids and feedback fail closed", () => {
  assert.throws(() => servedAnswerId({ namespace: "app", answer: "ok", extra: 1 }), {
    code: "invalid_input",
  });
  assert.throws(() => servedAnswerId({ namespace: "app", answer: "bad\ntext" }), {
    code: "invalid_input",
  });
  assert.throws(() => servedAnswerId({ namespace: "app", answer: "\u0085" }), {
    code: "invalid_input",
  });
  assert.throws(() => feedbackInput({ answerId: "ans_x", target, extra: true }), {
    code: "invalid_input",
  });
  assert.throws(() => feedbackInput({ answerId: "ans_x", target }), { code: "invalid_input" });
  assert.throws(() => feedbackInput({ answerId: "ans_x", target, note: "only" }), {
    code: "invalid_input",
  });
  assert.throws(
    () => feedbackInput({ answerId: "ans_x", target, rating: { kind: "numeric", value: 1.5 } }),
    { code: "invalid_input" },
  );
  assert.throws(() => feedbackInput({ answerId: "ans_x", target, edit: "fix\u0007" }), {
    code: "invalid_input",
  });
  assert.deepEqual(
    feedbackInput({ answerId: "ans_x", target, rating: { kind: "thumbs", value: "up" } }),
    { answerId: "ans_x", target, rating: { kind: "thumbs", value: "up" } },
  );
});

test("text length counts code points, including emoji and a next-line blank", () => {
  for (const item of served.text) {
    if (item.unit && item.accept !== undefined && typeof item.reject === "number") {
      const accepted = item.unit.repeat(item.accept);
      const rejected = item.unit.repeat(item.reject);
      assert.equal([...accepted].length, item.accept);
      assert.ok(accepted.length > item.accept);
      feedbackInput({
        answerId: "ans_x",
        target,
        rating: { kind: "thumbs", value: "up" },
        note: accepted,
      });
      assert.throws(
        () =>
          feedbackInput({
            answerId: "ans_x",
            target,
            rating: { kind: "thumbs", value: "up" },
            note: rejected,
          }),
        { code: "invalid_input" },
      );
    }
    if (item.text)
      assert.throws(
        () =>
          feedbackInput({
            answerId: "ans_x",
            target,
            rating: { kind: "thumbs", value: "up" },
            note: item.text,
          }),
        { code: "invalid_input" },
      );
  }
});

test("feedback persists, repeats, and promotion stops at the snapshot", async () => {
  const store = new InMemoryStore();
  const loop = loopWith(store);
  const scope = targetScope(target);
  const answerId = servedAnswerId({ namespace: "app", answer: "The invoice is paid." });
  const first = await loop.recordFeedback({
    answerId,
    target,
    rating: { kind: "numeric", value: 0.2 },
    edit: "The invoice is unpaid.",
    note: "reviewer",
  });
  const again = await loop.recordFeedback({
    answerId,
    target,
    rating: { kind: "numeric", value: 0.2 },
    edit: "The invoice is unpaid.",
    note: "reviewer",
  });
  assert.equal(again.id, first.id);
  const stored = await store.transaction("app", (tx) => tx.get("coordination", first.id));
  assert.equal(stored?.data.answerId, answerId);
  assert.equal(stored?.data.recordedAt, NOW);
  const seen = await store.transaction("app", (tx) => readFeedbackHead(tx, scope));
  const promoted = await store.transaction("app", (tx) =>
    promoteFeedbackCursor(tx, "app", NOW, scope, "run_1", seen),
  );
  assert.equal(promoted.position, first.id);
  assert.equal(promoted.previous, null);
  const repeat = await store.transaction("app", (tx) =>
    promoteFeedbackCursor(tx, "app", NOW, scope, "run_1", seen),
  );
  assert.deepEqual(repeat, promoted);
  const row = await store.transaction("app", (tx) =>
    tx.get("coordination", feedbackCursorId(scope)),
  );
  assert.equal(row?.revision, 1);
  const later = await loop.recordFeedback({
    answerId,
    target,
    edit: "after the run started",
  });
  const held = await store.transaction("app", (tx) =>
    promoteFeedbackCursor(tx, "app", NOW, scope, "run_2", seen),
  );
  assert.equal(held.position, first.id);
  assert.notEqual(held.position, later.id);
  const other = targetScope({ kind: "prompt", key: "other" });
  const isolated = await store.transaction("app", (tx) =>
    tx.get("coordination", feedbackCursorId(other)),
  );
  assert.equal(isolated, undefined);

  await store.transaction("app", (tx) =>
    tx.insert("runs", {
      id: "run_2",
      namespace: "app",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      format: 1,
      data: { selectedId: "cand-2" },
    }),
  );
  const rewound = await store.transaction("app", (tx) =>
    rewindPromotedCursor(tx, "app", NOW, { id: "cand-2", target }),
  );
  assert.equal(rewound.position, first.id);
  assert.equal(rewound.promotionId, null);
  const ignored = await store.transaction("app", (tx) =>
    rewindPromotedCursor(tx, "app", NOW, { id: "other", target }),
  );
  assert.equal(ignored.position, first.id);
});

test("a crash inside the cursor transaction keeps the previous records", async () => {
  const store = new InMemoryStore();
  const loop = loopWith(store);
  const answerId = servedAnswerId({ namespace: "app", answer: "kept" });
  await loop.recordFeedback({
    answerId,
    target,
    rating: { kind: "thumbs", value: "down" },
  });
  await assert.rejects(
    store.transaction("app", async (tx) => {
      await persistFeedback(
        tx,
        "app",
        NOW,
        feedbackInput({ answerId, target, edit: "replacement" }),
      );
      const seen = await readFeedbackHead(tx, targetScope(target));
      await promoteFeedbackCursor(tx, "app", NOW, targetScope(target), "run_crash", seen);
      throw new LoopiterError("callback_failed", "crash between steps");
    }),
  );
  const page = await store.transaction("app", (tx) => tx.list("coordination", { limit: 100 }));
  const feedback = page.items.filter((item) => item.data.kind === "feedback");
  assert.equal(feedback.length, 1);
  const rating = feedback[0]?.data.rating as { value?: string };
  assert.equal(rating.value, "down");
  assert.equal(
    page.items.some((item) => item.data.edit === "replacement"),
    false,
  );
  const cursor = await store.transaction("app", (tx) =>
    tx.get("coordination", feedbackCursorId(targetScope(target))),
  );
  assert.equal(cursor, undefined);
});

test("a malformed stored cursor fails closed", async () => {
  const scope = targetScope(target);
  const id = feedbackCursorId(scope);
  const plant = async (data: JsonObject) => {
    const store = new InMemoryStore();
    await store.transaction("app", (tx) =>
      tx.insert("coordination", {
        id,
        namespace: "app",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        format: 1,
        data,
      }),
    );
    await assert.rejects(
      store.transaction("app", (tx) =>
        promoteFeedbackCursor(tx, "app", NOW, scope, "run_1", {
          id: null,
          recordedAt: null,
          seq: null,
        }),
      ),
      { code: "invalid_state" },
    );
  };
  await plant({ position: 42, previous: {}, promotionId: 7 });
  await plant({
    kind: "feedback-cursor",
    position: null,
    positionAt: null,
    seq: null,
    previous: null,
    previousAt: null,
    previousSeq: null,
    promotionId: null,
    extra: true,
  });
});

test("caps reset on UTC day and month boundaries and ignore non-model calls", async () => {
  const store = new InMemoryStore();
  const caps = { monthlyBudget: 1, callCost: 1, runsPerDay: 1 };
  const scope = targetScope(target);
  const january = "2026-01-31T23:59:59.000Z";
  const february = "2026-02-01T00:00:00.000Z";
  await store.transaction("app", (tx) => admitModelCall(tx, "app", caps, january, "propose:0", scope));
  assert.equal(
    await store.transaction("app", (tx) => capBlock(tx, caps, january, "propose:0", scope)),
    "daily_run_cap",
  );
  assert.equal(
    await store.transaction("app", (tx) =>
      capBlock(tx, caps, january, "validation:candidate_1", scope),
    ),
    "budget_cap",
  );
  assert.equal(
    await store.transaction("app", (tx) => capBlock(tx, caps, february, "propose:0", scope)),
    undefined,
  );
  await store.transaction("app", (tx) =>
    admitModelCall(tx, "app", caps, january, "observe:1", scope),
  );
  const runs = await store.transaction("app", (tx) =>
    tx.get("coordination", `cap-runs:${scope}:2026-01-31`),
  );
  assert.equal(runs?.data.count, 1);
  const other = targetScope({ kind: "prompt", key: "other" });
  assert.equal(
    await store.transaction("app", (tx) => capBlock(tx, caps, january, "propose:0", other)),
    undefined,
  );
});

test("corrupt cap counters fail closed and a conflict spends nothing", async () => {
  const caps = { monthlyBudget: 1, callCost: 1, runsPerDay: 1 };
  const scope = targetScope(target);
  const bad = async (spend: unknown, runs: unknown) => {
    const tx = {
      get: async (_kind: string, id: string) => {
        if (id.startsWith("cap-runs:")) return { data: { count: runs } };
        if (id.startsWith("cap-spend:")) return { data: { amount: spend } };
        return undefined;
      },
    } as unknown as StoreTransaction;
    await assert.rejects(capBlock(tx, caps, NOW, "propose:0", scope), { code: "invalid_state" });
    await assert.rejects(admitModelCall(tx, "app", caps, NOW, "propose:0", scope), {
      code: "invalid_state",
    });
  };
  await bad("999", 0);
  await bad({}, 0);
  await bad(-1, 0);
  await bad(Number.NaN, 0);
  await bad(Number.POSITIVE_INFINITY, 0);
  await bad(true, 0);
  await bad({ nested: 1 }, 0);
  await bad(0, "5");
  await bad(0, -1);
  await bad(0, 1.5);
  await bad(0, Number.NaN);
  await bad(0, true);
  await bad(0, { nested: 1 });

  const store = new InMemoryStore();
  const inner = store.transaction.bind(store);
  store.transaction = (namespace, operation) =>
    inner(namespace, async (tx) => {
      const insert = tx.insert.bind(tx);
      const replace = tx.replace.bind(tx);
      tx.insert = async (kind, record) => {
        if (kind === "coordination" && record.id.startsWith("cap-"))
          fail("conflict", "injected");
        return insert(kind, record);
      };
      tx.replace = async (kind, record, expected) => {
        if (kind === "coordination" && record.id.startsWith("cap-"))
          fail("conflict", "injected");
        return replace(kind, record, expected);
      };
      return operation(tx);
    });
  await assert.rejects(
    store.transaction("app", (tx) => admitModelCall(tx, "app", caps, NOW, "propose:0", scope)),
    { code: "cap_conflict" },
  );
  const spent = await store.transaction("app", (tx) =>
    tx.get("coordination", `cap-spend:${scope}:2026-01`),
  );
  assert.equal(spent, undefined);
});

test("a malformed cursor does not block the rollback receipt", async () => {
  const store = new InMemoryStore();
  const loop = new FeedbackLoop({ store, namespace: "app", clock: () => new Date(NOW) });
  const adapter = new Registry();
  const candidate = await approved(loop, "served");
  await loop.deployCandidate(candidate.id, { adapter });
  const chat = { kind: "prompt", key: "chat" };
  const scope = targetScope(chat);
  const id = feedbackCursorId(scope);
  const malformed = { position: 42, previous: {}, promotionId: 7 };
  await store.transaction("app", (tx) =>
    tx.insert("coordination", {
      id,
      namespace: "app",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      format: 1,
      data: malformed,
    }),
  );
  await loop.rollbackCandidate(candidate.id, { adapter });
  const rolled = await loop.getCandidate(candidate.id);
  assert.equal(rolled?.status, "rolled_back");
  assert.ok(rolled?.rollbackReceipt);
  const attempts = await loop.list("attempts", { limit: 100 });
  assert.equal(
    attempts.items.some((item) => item.status === "pending"),
    false,
  );
  const targets = await loop.list("targets", { limit: 100 });
  for (const row of targets.items) assert.equal(row.pendingAttemptId, undefined);
  const cursor = await store.transaction("app", (tx) => tx.get("coordination", id));
  assert.equal(cursor?.revision, 1);
  assert.equal(cursor?.data.position, 42);
  const next = await approved(loop, "next");
  await loop.deployCandidate(next.id, { adapter });
  assert.equal((await loop.getCandidate(next.id))?.status, "deployed");
  await assert.rejects(
    store.transaction("app", (tx) =>
      promoteFeedbackCursor(tx, "app", NOW, scope, "run_next", {
        id: "feedback:later",
        recordedAt: NOW,
        seq: 1,
      }),
    ),
    { code: "invalid_state" },
  );
  const still = await store.transaction("app", (tx) => tx.get("coordination", id));
  assert.equal(still?.revision, 1);
  assert.equal(still?.data.position, 42);
});

test("feedback order follows the sequence when the clock does not", async () => {
  const store = new InMemoryStore();
  let now = NOW;
  const loop = new FeedbackLoop({ store, namespace: "app", clock: () => new Date(now) });
  const scope = targetScope(target);
  const first = await loop.recordFeedback({
    answerId: "ans_a",
    target,
    rating: { kind: "thumbs", value: "down" },
  });
  const seen = await store.transaction("app", (tx) => readFeedbackHead(tx, scope));
  assert.equal(seen.seq, 1);
  let laterId = "";
  let laterSeq = 0;
  for (let i = 0; i < 40 && !laterId; i++) {
    const saved = await loop.recordFeedback({
      answerId: "ans_a",
      target,
      edit: `same-ms-${i}`,
    });
    const row = await store.transaction("app", (tx) => tx.get("coordination", saved.id));
    if (saved.id < first.id) {
      laterId = saved.id;
      laterSeq = row?.data.seq as number;
    }
  }
  assert.ok(laterId < first.id);
  assert.ok(laterSeq > 1);
  const promoted = await store.transaction("app", (tx) =>
    promoteFeedbackCursor(tx, "app", NOW, scope, "run_1", seen),
  );
  assert.equal(promoted.position, first.id);
  assert.equal(promoted.seq, 1);
  assert.ok(laterSeq > (promoted.seq ?? 0));

  now = "2026-01-15T11:00:00.000Z";
  const skewed = await loop.recordFeedback({
    answerId: "ans_a",
    target,
    edit: "clock went backwards",
  });
  const skewedRow = await store.transaction("app", (tx) => tx.get("coordination", skewed.id));
  assert.ok(String(skewedRow?.data.recordedAt) < NOW);
  assert.ok((skewedRow?.data.seq as number) > 1);
  const held = await store.transaction("app", (tx) =>
    promoteFeedbackCursor(tx, "app", now, scope, "run_2", seen),
  );
  assert.equal(held.seq, 1);
  assert.equal(held.position, first.id);
  assert.ok((skewedRow?.data.seq as number) > (held.seq ?? 0));
});

test("a bad feedback sequence fails closed", async () => {
  const scope = targetScope(target);
  const headId = feedbackHeadId(scope);
  for (const seq of ["3", -1, 1.5, true]) {
    const store = new InMemoryStore();
    await store.transaction("app", (tx) =>
      tx.insert("coordination", {
        id: headId,
        namespace: "app",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        format: 1,
        data: {
          kind: "feedback-head",
          id: "feedback:old",
          recordedAt: NOW,
          seq,
        },
      }),
    );
    await assert.rejects(store.transaction("app", (tx) => readFeedbackHead(tx, scope)), {
      code: "invalid_state",
    });
  }
  for (const seq of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const tx = {
      get: async () => ({
        data: { kind: "feedback-head", id: "feedback:old", recordedAt: NOW, seq },
      }),
    } as unknown as StoreTransaction;
    await assert.rejects(readFeedbackHead(tx, scope), { code: "invalid_state" });
  }
  const store = new InMemoryStore();
  const loop = new FeedbackLoop({ store, namespace: "app", clock: () => new Date(NOW) });
  const saved = await loop.recordFeedback({
    answerId: "ans_a",
    target,
    rating: { kind: "thumbs", value: "up" },
  });
  await store.transaction("app", async (tx) => {
    const row = (await tx.get("coordination", saved.id))!;
    await tx.replace(
      "coordination",
      { ...row, revision: row.revision + 1, data: { ...row.data, seq: "1" } },
      row.revision,
    );
  });
  await assert.rejects(
    loop.recordFeedback({
      answerId: "ans_a",
      target,
      rating: { kind: "thumbs", value: "up" },
    }),
    { code: "invalid_state" },
  );
});
