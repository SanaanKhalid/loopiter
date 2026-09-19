import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import {
  FeedbackLoop,
  type FeedbackStore,
  type StoreTransaction,
} from "../src/index.js";
import { PostgresStore, migratePostgres } from "../src/postgres.js";
import { runStoreConformance } from "../src/testing.js";
import { PostgresPromptRegistry } from "../examples/prompt-improvement/registry.js";
import {
  PromptStarter,
  FixtureProvider,
} from "../examples/prompt-improvement/workflow.js";
const connectionString = process.env.LOOPITER_TEST_DATABASE_URL;
test(
  "PostgreSQL: conformance, independent-process races, starter and receipt failure recovery",
  { skip: !connectionString },
  async () => {
    const pool = new Pool({ connectionString }),
      otherPool = new Pool({ connectionString });
    const namespace = `integration/${randomUUID()}`;
    const store = new PostgresStore(pool),
      otherStore = new PostgresStore(otherPool);
    try {
      await migratePostgres(pool);
      await migratePostgres(pool);
      assert.equal((await runStoreConformance(store)).length, 9);
      const loop = new FeedbackLoop({ store, namespace });
      await loop.recordExecution({ id: "race", kind: "turn" });
      const worker = (value: string) =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(new URL("./postgres-worker.js", import.meta.url)),
              namespace,
              value,
            ],
            { env: process.env, stdio: "pipe" },
          );
          child.on("error", reject);
          child.on("close", resolve);
        });
      assert.deepEqual(
        (await Promise.all([worker("a"), worker("b")])).sort(),
        [0, 2],
      );
      const signal = new AbortController().signal,
        registry = new PostgresPromptRegistry(pool, namespace);
      await registry.initialize();
      const starter = new PromptStarter(loop, new FixtureProvider(), registry);
      await starter.seed(signal);
      const proposal = await starter.recommend(signal);
      assert.ok(proposal.candidate);
      await starter.evaluate(proposal.candidate.id, signal);
      const candidate = await starter.approve(
        proposal.candidate.id,
        "integration-review",
      );
      let failOnce = true;
      const faulty: FeedbackStore = {
        version: 3,
        close: () => store.close(),
        deleteNamespace: (n) => store.deleteNamespace(n),
        transaction: <T>(n: string, fn: (tx: StoreTransaction) => Promise<T>) =>
          store.transaction(n, (tx) =>
            fn({
              ...tx,
              replace: async (kind, row, rev) => {
                if (
                  failOnce &&
                  kind === "attempts" &&
                  "status" in row &&
                  row.status === "succeeded"
                ) {
                  failOnce = false;
                  throw new Error("Injected finalization outage.");
                }
                await tx.replace(kind, row, rev);
              },
            }),
          ),
      };
      const faultLoop = new FeedbackLoop({ store: faulty, namespace });
      await assert.rejects(
        faultLoop.deployCandidate(candidate.id, {
          adapter: registry,
          expectedArtifactVersion: String(candidate.metadata.baseVersion),
        }),
        /pending/,
      );
      const pending = (await loop.list("attempts")).items.find(
        (a) => a.status === "pending",
      )!;
      assert.ok(pending);
      const recoveryLoop = new FeedbackLoop({ store: otherStore, namespace });
      await recoveryLoop.reconcileAttempt(
        pending.id,
        new PostgresPromptRegistry(otherPool, namespace),
      );
      assert.equal((await registry.current()).version, candidate.contentHash);
      await recoveryLoop.rollbackCandidate(candidate.id, { adapter: registry });
      assert.equal(
        (await registry.current()).version,
        candidate.metadata.baseVersion,
      );
      // Two independently pooled clients must serialize deployments for the same target.
      for (const id of ["a", "b"]) {
        await loop.createCandidate({
          id,
          target: candidate.target,
          proposedChange: {
            fragment: `Billing covers payments; candidate ${id}.`,
          },
          risk: "low",
          evidence: {},
        });
        const evaluated = await loop.evaluateCandidate(
          id,
          {
            evaluator: "concurrency-fixture",
            version: "1",
            datasetHash: "simulated",
          },
          () => ({ passed: true }),
        );
        await loop.approveCandidate(id, {
          actor: "fixture",
          evaluationId: evaluated.evaluations[0]!.id,
        });
      }
      const race = await Promise.allSettled([
        loop.deployCandidate("a", {
          adapter: registry,
          expectedArtifactVersion: String(candidate.metadata.baseVersion),
        }),
        recoveryLoop.deployCandidate("b", {
          adapter: new PostgresPromptRegistry(otherPool, namespace),
          expectedArtifactVersion: String(candidate.metadata.baseVersion),
        }),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (await loop.list("candidates")).items.filter(
          (c) => c.status === "deployed",
        ).length,
        1,
      );
      const rows = await pool.query(
        "SELECT count(*)::integer AS n FROM feloop_starter_receipts WHERE namespace=$1 AND receipt IS NOT NULL",
        [namespace],
      );
      assert.equal(rows.rows[0].n, 3);
    } finally {
      await store.deleteNamespace(namespace);
      for (const table of [
        "feloop_starter_receipts",
        "feloop_starter_active",
        "feloop_starter_prompts",
      ])
        await pool
          .query(`DELETE FROM ${table} WHERE namespace=$1 OR namespace=$2`, [
            namespace,
            `${namespace}/race`,
          ])
          .catch(() => {});
      await pool.end();
      await otherPool.end();
    }
  },
);
