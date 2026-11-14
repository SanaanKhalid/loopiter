import test from "node:test";
import assert from "node:assert/strict";
import { FeedbackLoop, InMemoryStore } from "../src/index.js";
import { importBatch } from "../src/integrations/import-batch.js";

const when = "2026-03-01T15:04:05.000Z";

function record(
  idempotencyKey: string,
  stageId: string,
  prompt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    idempotencyKey,
    occurredAt: when,
    status: "success",
    stageId,
    versions: { prompt, model: "fixture" },
    usage: { state: "unknown" },
    ...extra,
  };
}

const ticket = record("ticket-100", "classify", "support-ticket-v1");
const invoice = record("invoice-200", "billing", "invoice-v1");
const listing = record("listing-300", "catalog", "product-listing-v1");

function setup() {
  return new FeedbackLoop({ store: new InMemoryStore(), namespace: "imports" });
}

test("historical import keeps source time, dedupes, and does not attach a release", async () => {
  const loop = setup();
  const first = await importBatch(loop, [ticket, invoice, listing]);
  assert.deepEqual(first, { accepted: 3, conflicts: 0, rejected: 0 });
  assert.deepEqual(await importBatch(loop, [ticket, invoice, listing]), first);
  const historical = (await loop.list("historical")).items;
  assert.equal(historical.length, 3);
  assert.deepEqual((await loop.list("executions")).items, []);
  assert.deepEqual((await loop.list("targets")).items, []);
  const imported = historical.find((row) => row.id === "ticket-100")!;
  const original = imported.original as {
    occurredAt: string;
    usage: { state: string; tokens?: number };
    versions: { config?: string };
    releaseId?: string;
  };
  assert.equal(imported.createdAt, when);
  assert.equal(original.occurredAt, when);
  assert.equal(original.usage.state, "unknown");
  assert.equal(original.usage.tokens, undefined);
  assert.equal(JSON.stringify(original).includes('"tokens"'), false);
  assert.equal(original.versions.config, undefined);
  assert.equal(original.releaseId, undefined);
  const changed = { ...ticket, status: "error" };
  assert.equal((await importBatch(loop, [changed])).conflicts, 1);
  assert.equal(
    (historical.find((row) => row.id === "ticket-100")!.original as { status: string }).status,
    "success",
  );
  const again = (await loop.list("historical")).items.find((row) => row.id === "ticket-100")!;
  assert.equal((again.original as { status: string }).status, "success");
  const dropped = await importBatch(loop, [
    record("ticket-drop", "classify", "support-ticket-v1", { status: "dropped" }),
    record("invoice-zero", "billing", "invoice-v1", {
      usage: { state: "unknown", tokens: 0 },
    }),
    { ...listing, releaseId: "current" },
  ]);
  assert.deepEqual(dropped, { accepted: 1, conflicts: 0, rejected: 2 });
  const tombstone = (await loop.list("historical")).items.find((row) => row.id === "ticket-drop")!;
  assert.equal((tombstone.original as { status: string }).status, "dropped");
  assert.deepEqual((await loop.list("executions")).items, []);
  const known = await importBatch(loop, [
    record("invoice-known", "billing", "invoice-v1", { usage: { state: "known", tokens: 4 } }),
  ]);
  assert.equal(known.accepted, 1);
  const billed = (await loop.list("historical")).items.find((row) => row.id === "invoice-known")!;
  assert.equal((billed.original as { usage: { tokens: number } }).usage.tokens, 4);
});
