/** Independent process fixture: no provider/network model calls. */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  FeedbackLoop,
  ImprovementController,
  type ImprovementWorkflow,
  type AutonomyPolicy,
} from "../src/index.js";
import { PostgresStore } from "../src/postgres.js";
import { PostgresArtifactRegistry } from "../examples/autonomous/postgres-registry.js";
const namespace = process.argv[2]!,
  action = process.argv[3] ?? "tick";
const pool = new Pool({
  connectionString: process.env.LOOPITER_TEST_DATABASE_URL,
});
try {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../python/tests/fixtures/autonomy.json", import.meta.url),
      "utf8",
    ),
  );
  const policy = fixture.policy as AutonomyPolicy;
  const registry = new PostgresArtifactRegistry(pool, namespace, policy.target);
  if (action === "init") {
    await registry.initialize({ score: 0 }, "model-v1");
    console.log("initialized");
  } else {
    const now =
      action === "observe"
        ? "2026-02-01T02:00:00.000Z"
        : "2026-02-01T00:00:00.000Z";
    const loop = new FeedbackLoop({
      namespace,
      store: new PostgresStore(pool),
      clock: () => new Date(now),
    });
    const rows = (part: string, count: number, day: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${part}-${i}`,
        episodeId: `${part}-${i}`,
        entityId: `${part}-${i}`,
        source: "verified-human",
        input: "fixture",
        label: "yes",
        occurredAt: `2026-01-0${day}T00:00:00Z`,
        observedAt: `2026-01-0${day}T01:00:00Z`,
      }));
    const workflow: ImprovementWorkflow = {
      id: "classification",
      version: "1",
      optimizerVersion: "1",
      evaluatorVersion: "1",
      policy,
      artifact: async () => {
        const c = await registry.current();
        return {
          artifactVersion: c.version,
          configurationHash: c.configurationHash,
        };
      },
      dataset: async () => ({
        version: "fixture",
        optimization: rows("train", 3, 1),
        validation: rows("validation", 20, 2),
        audit: rows("audit", 50, 3),
      }),
      propose: async (_, c) =>
        c.meter(100, async () => ({
          value: [{ score: 1 }, { score: 0.8 }],
          tokens: 40,
        })),
      evaluate: async (i) => ({
        cases: i.examples.map((r) => ({
          id: r.id,
          baseline: 0,
          candidate: (i.change as { score: number }).score,
        })),
        metrics: { errors: 0 },
        estimatedServingCost: 1,
      }),
      deployment: {
        apply: async (r) => {
          const receipt = await registry.apply(r);
          if (action === "interrupt") throw Error("INJECTED response loss");
          return receipt;
        },
        inspect: (r) => registry.inspect(r),
        rollback: (r) => registry.rollback(r),
      },
      observe: async (i) => ({
        artifactVersion: i.artifactVersion,
        configurationHash: "model-v1",
        startedAt: i.deployedAt,
        endedAt: now,
        complete: true,
        unitIds: Array.from({ length: 10 }, (_, n) => `production-${n}`),
        metrics: { errors: 0 },
      }),
    };
    console.log(
      JSON.stringify(
        await new ImprovementController(loop, {
          workflows: [workflow],
          mode: "autonomous",
          selfImproving: true,
        }).tick("classification"),
      ),
    );
  }
} finally {
  await pool.end();
}
