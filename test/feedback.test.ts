import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FeedbackLoop, InMemoryStore, LoopiterError, servedAnswerId } from "../src/index.js";
import {
  applyFeedbackCursor,
  feedbackInput,
  persistFeedback,
} from "../src/feedback.js";
import { admitModelCall, capBlock } from "../src/run-caps.js";

const served = JSON.parse(
  await readFile(new URL("../../test/fixtures/served-answer.json", import.meta.url), "utf8"),
) as { cases: { input: Record<string, string>; id: string }[] };

const NOW = "2026-01-15T12:00:00.000Z";

test("served answer ids match the shared fixture", () => {
  for (const item of served.cases) assert.equal(servedAnswerId(item.input), item.id);
  assert.notEqual(served.cases[0]!.id, served.cases[1]!.id);
});

test("served answer ids and feedback fail closed", () => {
  assert.throws(() => servedAnswerId({ namespace: "app", answer: "ok", extra: 1 }), {
    code: "invalid_input",
  });
  assert.throws(() => servedAnswerId({ namespace: "app", answer: "bad\ntext" }), {
    code: "invalid_input",
  });
  assert.throws(() => feedbackInput({ answerId: "ans_x", extra: true }), { code: "invalid_input" });
  assert.throws(() => feedbackInput({ answerId: "ans_x" }), { code: "invalid_input" });
  assert.throws(() => feedbackInput({ answerId: "ans_x", note: "only" }), { code: "invalid_input" });
  assert.throws(
    () => feedbackInput({ answerId: "ans_x", rating: { kind: "numeric", value: 1.5 } }),
    { code: "invalid_input" },
  );
  assert.throws(
    () => feedbackInput({ answerId: "ans_x", edit: "fix\u0007" }),
    { code: "invalid_input" },
  );
  assert.deepEqual(feedbackInput({ answerId: "ans_x", rating: { kind: "thumbs", value: "up" } }), {
    answerId: "ans_x",
    rating: { kind: "thumbs", value: "up" },
  });
});

test("feedback persists, repeats, and the cursor moves only with promotion", async () => {
  const store = new InMemoryStore();
  const loop = new FeedbackLoop({ store, namespace: "app", clock: () => new Date(NOW) });
  const answerId = servedAnswerId({ namespace: "app", answer: "The invoice is paid." });
  const first = await loop.recordFeedback({
    answerId,
    rating: { kind: "numeric", value: 0.2 },
    edit: "The invoice is unpaid.",
    note: "reviewer",
  });
  const again = await loop.recordFeedback({
    answerId,
    rating: { kind: "numeric", value: 0.2 },
    edit: "The invoice is unpaid.",
    note: "reviewer",
  });
  assert.equal(again.id, first.id);
  const stored = await store.transaction("app", (tx) => tx.get("coordination", first.id));
  assert.equal(stored?.data.answerId, answerId);
  assert.equal(stored?.data.recordedAt, NOW);

  const promoted = await store.transaction("app", (tx) =>
    applyFeedbackCursor(tx, "app", NOW, "promote", "run_1"),
  );
  assert.equal(promoted.position, first.id);
  assert.equal(promoted.previous, null);
  const repeat = await store.transaction("app", (tx) =>
    applyFeedbackCursor(tx, "app", NOW, "promote", "run_1"),
  );
  assert.deepEqual(repeat, promoted);
  const row = await store.transaction("app", (tx) => tx.get("coordination", "feedback-cursor"));
  assert.equal(row?.revision, 1);

  const rewound = await store.transaction("app", (tx) =>
    applyFeedbackCursor(tx, "app", NOW, "rollback", "run_1"),
  );
  assert.equal(rewound.position, null);
  assert.equal(rewound.promotionId, null);
  const rewoundAgain = await store.transaction("app", (tx) =>
    applyFeedbackCursor(tx, "app", NOW, "rollback", "run_1"),
  );
  assert.deepEqual(rewoundAgain, rewound);
});

test("a crash inside the cursor transaction keeps the previous records", async () => {
  const store = new InMemoryStore();
  const loop = new FeedbackLoop({ store, namespace: "app", clock: () => new Date(NOW) });
  const answerId = servedAnswerId({ namespace: "app", answer: "kept" });
  await loop.recordFeedback({ answerId, rating: { kind: "thumbs", value: "down" } });
  await assert.rejects(
    store.transaction("app", async (tx) => {
      await persistFeedback(
        tx,
        "app",
        NOW,
        feedbackInput({ answerId, edit: "replacement" }),
      );
      await applyFeedbackCursor(tx, "app", NOW, "promote", "run_crash");
      throw new LoopiterError("callback_failed", "crash between steps");
    }),
  );
  const page = await store.transaction("app", (tx) => tx.list("coordination", { limit: 100 }));
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.data.kind, "feedback");
  const rating = page.items[0]?.data.rating as { value?: string };
  assert.equal(rating.value, "down");
});

test("caps reset on UTC day and month boundaries and ignore non-model calls", async () => {
  const store = new InMemoryStore();
  const caps = { monthlyBudget: 1, callCost: 1, runsPerDay: 1 };
  const january = "2026-01-31T23:59:59.000Z";
  const february = "2026-02-01T00:00:00.000Z";
  await store.transaction("app", (tx) =>
    admitModelCall(tx, "app", caps, january, "propose:0"),
  );
  assert.equal(
    await store.transaction("app", (tx) => capBlock(tx, caps, january, "propose:0")),
    "daily_run_cap",
  );
  assert.equal(
    await store.transaction("app", (tx) => capBlock(tx, caps, january, "validation:candidate_1")),
    "budget_cap",
  );
  assert.equal(
    await store.transaction("app", (tx) => capBlock(tx, caps, february, "propose:0")),
    undefined,
  );
  await store.transaction("app", (tx) =>
    admitModelCall(tx, "app", caps, january, "observe:1"),
  );
  const runs = await store.transaction("app", (tx) => tx.get("coordination", "cap-runs:2026-01-31"));
  assert.equal(runs?.data.count, 1);
});
