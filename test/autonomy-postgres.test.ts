import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { FeedbackLoop } from "../src/index.js";
import { PostgresStore, migratePostgres } from "../src/postgres.js";
import {
  migrateArtifactRegistry,
  PostgresArtifactRegistry,
} from "../examples/autonomous/postgres-registry.js";

test(
  "autonomous PostgreSQL: independent workers, receipt loss, inspection and observation",
  { skip: !process.env.LOOPITER_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
        connectionString: process.env.LOOPITER_TEST_DATABASE_URL,
      }),
      store = new PostgresStore(pool),
      namespace = `autonomy-test/${randomUUID()}`;
    const registry = new PostgresArtifactRegistry(pool, namespace, {
      kind: "prompt",
      key: "test-classifier",
    });
    const worker = (action: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("./autonomy-postgres-worker.js", import.meta.url),
            ),
            namespace,
            action,
          ],
          { env: process.env, stdio: "pipe" },
        );
        let output = "",
          error = "";
        child.stdout.on("data", (c) => (output += c));
        child.stderr.on("data", (c) => (error += c));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(output.trim()) : reject(Error(error)),
        );
      });
    try {
      await migratePostgres(pool);
      await migrateArtifactRegistry(pool);
      await worker("init");
      await Promise.all([worker("tick"), worker("tick")]);
      const loop = new FeedbackLoop({ store, namespace });
      const runs = (await loop.list("runs")).items;
      assert.equal(runs.length, 1);
      assert.equal(
        (await loop.list("budgets")).items[0]!.data.modelRequests,
        1,
      );
      let result = JSON.parse(await worker("tick"));
      for (let n = 0; n < 3 && result.state !== "deploying"; n++)
        result = JSON.parse(await worker("tick"));
      assert.equal(result.state, "deploying");
      result = JSON.parse(await worker("interrupt"));
      assert.equal(result.state, "reconciliation_required");
      result = JSON.parse(await worker("tick"));
      assert.equal(result.state, "observing");
      result = JSON.parse(await worker("observe"));
      assert.equal(result.state, "completed");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM loopiter_example_receipts WHERE scope=$1 AND receipt IS NOT NULL",
            [registry.scope],
          )
        ).rows[0].n,
        1,
      );
      const candidate = (await loop.list("candidates")).items.find(
        (c) => c.status === "deployed",
      )!;
      assert.deepEqual(candidate.proposedChange, { score: 1 });
      await loop.rollbackCandidate(candidate.id, { adapter: registry });
      assert.deepEqual((await registry.current()).artifact, { score: 0 });
    } finally {
      await store.deleteNamespace(namespace);
      for (const table of [
        "loopiter_example_receipts",
        "loopiter_example_targets",
        "loopiter_example_artifacts",
      ])
        await pool.query(`DELETE FROM ${table} WHERE scope=$1`, [
          registry.scope,
        ]);
      await pool.end();
    }
  },
);
