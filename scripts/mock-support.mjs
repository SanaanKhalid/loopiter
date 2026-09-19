/** Offline integration lab: real HTTP/PostgreSQL/processes; simulated model, users and clock. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { FeedbackLoop, ImprovementController } from "../dist/src/index.js";
import { PostgresStore, migratePostgres } from "../dist/src/postgres.js";
import {
  PostgresArtifactRegistry,
  migrateArtifactRegistry,
} from "../dist/examples/autonomous/postgres-registry.js";

const connectionString = process.env.LOOPITER_TEST_DATABASE_URL;
if (!connectionString)
  throw Error("Set LOOPITER_TEST_DATABASE_URL to a disposable test database.");
const pool = new Pool({ connectionString });
const target = { kind: "routing", key: "support-queue" };
const config = "mock-keyword-classifier-v1";
const original = { billing: "access", access: "billing", other: "other" };
const correct = { billing: "billing", access: "access", other: "other" };
const labels = Object.keys(original);
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const segment = (text) =>
  /invoice|charged|refund/.test(text)
    ? "billing"
    : /login|password|locked/.test(text)
      ? "access"
      : "other";
const predict = (artifact, text) => artifact[segment(text)];
const at = (day) => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const namespace = process.argv[3];
const store = new PostgresStore(pool);

async function all(loop, collection) {
  const result = [];
  let cursor;
  do {
    const page = await loop.list(collection, {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    result.push(...page.items);
    cursor = page.nextCursor;
    if (result.length > 1000) throw Error("Lab query limit exceeded");
  } while (cursor);
  return result;
}

async function workflowFor(ns, now, inject) {
  const loop = new FeedbackLoop({
    namespace: ns,
    store,
    clock: () => new Date(now),
  });
  const registry = new PostgresArtifactRegistry(pool, ns, target);
  const policy = JSON.parse(
    await readFile(
      new URL("../python/tests/fixtures/autonomy.json", import.meta.url),
      "utf8",
    ),
  ).policy;
  Object.assign(policy, {
    version: "mock-support-v1",
    target,
    changeSchema: {
      type: "object",
      properties: Object.fromEntries(
        labels.map((l) => [l, { type: "string", enum: labels }]),
      ),
      required: labels,
      additionalProperties: false,
    },
    minimumNewUnits: 3,
    minimumValidationUnits: 21,
    minimumAuditUnits: 60,
    maximumCandidates: 2,
    maximumProposalCalls: 1,
  });
  policy.guardrails = labels.map((l) => ({
    metric: `accuracy:${l}`,
    comparator: "gte",
    value: 0.8,
  }));
  async function labeled() {
    const [executions, signals] = await Promise.all([
      all(loop, "executions"),
      all(loop, "signals"),
    ]);
    const byExecution = new Map();
    for (const s of signals) {
      if (s.source !== "verified-human") continue;
      const group = byExecution.get(s.executionId) ?? [];
      group.push(s);
      byExecution.set(s.executionId, group);
    }
    return executions.flatMap((e) => {
      const signals = byExecution.get(e.id) ?? [];
      // Contradictory trusted corrections quarantine the entire episode; no last-write-wins label.
      if (new Set(signals.map((s) => s.value)).size !== 1) return [];
      const first = signals.sort((a, b) =>
        a.observedAt.localeCompare(b.observedAt),
      )[0];
      return [
        {
          execution: e,
          row: {
            id: e.id,
            episodeId: e.episodeId,
            entityId: e.entityId,
            source: first.source,
            input: e.input,
            label: first.value,
            occurredAt: e.startedAt,
            observedAt: first.observedAt,
          },
        },
      ];
    });
  }
  const workflow = {
    id: "support",
    version: "1",
    optimizerVersion: "majority-corrections-v1",
    evaluatorVersion: "exact-match-v1",
    policy,
    artifact: async () => {
      const a = await registry.current();
      return {
        artifactVersion: a.version,
        configurationHash: a.configurationHash,
      };
    },
    dataset: async () => {
      const rows = await labeled();
      const data = Object.fromEntries(
        ["optimization", "validation", "audit"].map((p) => [
          p,
          rows
            .filter((x) => x.row.input.partition === p)
            .map((x) => x.row)
            .sort((a, b) => a.id.localeCompare(b.id)),
        ]),
      );
      return { version: digest(data), ...data };
    },
    propose: async ({ examples, baseline }, context) =>
      context.meter(100, async () => {
        const mapping = { ...(await registry.get(baseline.artifactVersion)) };
        for (const s of labels) {
          const votes = examples
            .filter((r) => segment(r.input.text) === s)
            .map((r) => r.label);
          if (votes.length)
            mapping[s] = labels.toSorted(
              (a, b) =>
                votes.filter((v) => v === b).length -
                votes.filter((v) => v === a).length,
            )[0];
        }
        // A second weaker proposal must not replace the best passing mapping.
        return {
          value: [mapping, { ...mapping, other: "billing" }],
          tokens: 0,
        };
      }),
    evaluate: async ({ baseline, change, examples }) => {
      const old = await registry.get(baseline.artifactVersion);
      const cases = examples.map((r) => ({
        id: r.id,
        baseline: Number(predict(old, r.input.text) === r.label),
        candidate: Number(predict(change, r.input.text) === r.label),
      }));
      return {
        cases,
        estimatedServingCost: 0,
        metrics: Object.fromEntries(
          labels.map((l) => {
            const subset = examples.filter((r) => r.label === l);
            return [
              `accuracy:${l}`,
              subset.length
                ? subset.filter((r) => predict(change, r.input.text) === l)
                    .length / subset.length
                : 0,
            ];
          }),
        ),
      };
    },
    deployment: {
      apply: async (r) => {
        const receipt = await registry.apply(r);
        if (inject)
          throw Error("INJECTED lost response after durable external apply");
        return receipt;
      },
      inspect: (r) => registry.inspect(r),
      rollback: (r) => registry.rollback(r),
    },
    observe: async (i) => {
      const rows = (await labeled()).filter(
        (x) =>
          x.execution.artifacts.router === i.artifactVersion &&
          x.row.input.partition === "production" &&
          Date.parse(x.row.observedAt) + policy.outcomeMaturityMs <=
            Date.parse(now),
      );
      return {
        artifactVersion: i.artifactVersion,
        configurationHash: config,
        startedAt: i.deployedAt,
        endedAt: now,
        complete: true,
        unitIds: rows.map((x) => x.row.episodeId),
        metrics: {
          errors: rows.length
            ? rows.filter((x) => x.execution.output !== x.row.label).length /
              rows.length
            : 0,
        },
      };
    },
  };
  return { loop, registry, workflow };
}

async function worker() {
  const { loop, workflow } = await workflowFor(
    namespace,
    process.env.MOCK_NOW,
    process.env.MOCK_INTERRUPT === "1",
  );
  const controller = new ImprovementController(loop, {
    workflows: [workflow],
    mode: "autonomous",
    selfImproving: process.env.MOCK_ENABLED !== "0",
  });
  console.log(JSON.stringify(await controller.tick("support")));
}

async function lab() {
  // Only explicit lab invocation migrates; SDK construction never does.
  await migratePostgres(pool);
  await migrateArtifactRegistry(pool);
  const reviewerToken = randomUUID();
  const scopes = [];
  const evidence = {
    kind: "SIMULATED support integration; real HTTP, PostgreSQL and independent processes",
    generatedAt: new Date().toISOString(),
    scenarios: [],
  };
  try {
    for (const scenario of ["retain", "regress", "reject", "timeout"]) {
      const ns = `mock-support/${randomUUID()}`;
      const { loop, registry } = await workflowFor(ns, at(10), false);
      scopes.push({ ns, registry });
      await registry.initialize(original, config);
      const initial = await registry.current();
      const server = createServer(async (request, response) => {
        try {
          if (
            request.method !== "POST" ||
            !["/tickets", "/corrections"].includes(request.url)
          ) {
            response.writeHead(404).end();
            return;
          }
          if (request.headers.authorization !== `Bearer ${reviewerToken}`) {
            response.writeHead(401).end();
            return;
          }
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 8192) throw Error("Payload too large");
          }
          const b = JSON.parse(body);
          let result;
          if (request.url === "/tickets") {
            // Replays return the original prediction, even after a router deployment.
            const existing = await loop.getExecution(b.id);
            if (existing) {
              assert.deepEqual(existing.input, b.input);
              result = existing;
            } else {
              const a = await registry.current();
              result = await loop.recordExecution({
                id: b.id,
                episodeId: b.id,
                entityId: `customer-${b.id}`,
                kind: "prediction",
                input: b.input,
                output: predict(a.artifact, b.input.text),
                artifacts: { router: a.version, model: config },
                startedAt: b.startedAt,
              });
            }
          } else {
            assert(labels.includes(b.label));
            result = await loop.recordSignal({
              id: b.id,
              executionId: b.ticket,
              kind: "correction",
              name: "reviewed-route",
              source: "verified-human",
              value: b.label,
              observedAt: b.observedAt,
            });
          }
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
        } catch (error) {
          response
            .writeHead(409, { "content-type": "application/json" })
            .end(JSON.stringify({ error: error.message }));
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = async (
          path,
          body,
          status = 200,
          token = reviewerToken,
        ) => {
          const r = await fetch(base + path, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
          const text = await r.text();
          assert.equal(r.status, status, text);
          return text ? JSON.parse(text) : null;
        };
        const child = (now = at(10), enabled = true, interrupt = false) =>
          new Promise((resolve, reject) => {
            const p = spawn(
              process.execPath,
              [fileURLToPath(import.meta.url), "worker", ns],
              {
                env: {
                  ...process.env,
                  MOCK_NOW: now,
                  MOCK_ENABLED: enabled ? "1" : "0",
                  MOCK_INTERRUPT: interrupt ? "1" : "0",
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let out = "",
              err = "";
            p.stdout.on("data", (b) => (out += b));
            p.stderr.on("data", (b) => (err += b));
            p.on("error", reject);
            p.on("close", (c) =>
              c === 0 ? resolve(JSON.parse(out)) : reject(Error(err)),
            );
          });
        await post("/corrections", {}, 401, "untrusted");
        assert.equal((await child()).state, "waiting_for_evidence");
        const samples = [
          "Please refund this invoice",
          "My password is locked",
          "Where is the user guide",
        ];
        for (const [partition, count, day] of [
          ["optimization", 9, 1],
          ["validation", 21, 3],
          ["audit", 60, 5],
        ]) {
          for (let n = 0; n < count; n++) {
            const id = `${partition}-${n}`,
              label = labels[n % 3];
            const ticket = {
              id,
              input: { text: `${samples[n % 3]} #${n}`, partition },
              startedAt: at(day),
            };
            await post("/tickets", ticket);
            const correction = {
              id: `review-${id}`,
              ticket: id,
              label:
                scenario === "reject" && partition === "optimization"
                  ? original[label]
                  : label,
              observedAt: at(day + 1),
            };
            await post("/corrections", correction);
            await post("/corrections", correction); // webhook redelivery
            if (n === 0)
              await post(
                "/tickets",
                {
                  ...ticket,
                  input: { ...ticket.input, text: "conflicting replay" },
                },
                409,
              );
          }
        }
        // Extra contradictory episode must not participate in any partition.
        await post("/tickets", {
          id: "contradiction",
          input: { text: "invoice", partition: "optimization" },
          startedAt: at(1),
        });
        for (const label of ["billing", "access"])
          await post("/corrections", {
            id: `contradiction-${label}`,
            ticket: "contradiction",
            label,
            observedAt: at(2),
          });
        const snapshot = await (
          await workflowFor(ns, at(10), false)
        ).workflow.dataset();
        assert.equal(snapshot.optimization.length, 9);
        const states = [];
        await child(at(10), false);
        assert.deepEqual((await registry.current()).artifact, original);
        assert.equal(
          (await all(loop, "candidates")).length,
          0,
          "disabled flag must not propose changes",
        );
        await Promise.all([child(), child()]); // independent workers race
        let result;
        for (let n = 0; n < 12; n++) {
          result = await child();
          states.push(result.state);
          if (["deploying", "no_improvement"].includes(result.state)) break;
        }
        if (scenario === "reject") {
          assert.equal(result.state, "no_improvement");
          const operations = (await all(loop, "operations")).length;
          await child();
          await child();
          assert.equal(
            (await all(loop, "operations")).length,
            operations,
            "unchanged evidence must not repeat callbacks",
          );
          assert.deepEqual((await registry.current()).artifact, original);
        } else {
          assert.equal(result.state, "deploying");
          result = await child(at(10), true, true);
          states.push(result.state);
          assert.equal(result.state, "reconciliation_required");
          result = await child();
          states.push(result.state);
          assert.equal(result.state, "observing");
          assert.deepEqual((await registry.current()).artifact, correct);
          for (let n = 0; n < 12; n++) {
            const ticket = await post("/tickets", {
              id: `production-${n}`,
              input: { text: samples[n % 3], partition: "production" },
              startedAt: at(10),
            });
            assert.equal(ticket.output, labels[n % 3]);
          }
          const feedbackAt = "2026-01-10T02:00:00.000Z";
          result = await child(feedbackAt);
          assert.equal(
            result.state,
            "observing",
            "missing labels must not complete observation",
          );
          if (scenario !== "timeout")
            for (let n = 0; n < 12; n++)
              await post("/corrections", {
                id: `production-review-${n}`,
                ticket: `production-${n}`,
                label:
                  scenario === "regress"
                    ? original[labels[n % 3]]
                    : labels[n % 3],
                observedAt: feedbackAt,
              });
          result = await child(feedbackAt);
          assert.equal(
            result.state,
            "observing",
            "immature labels must not count",
          );
          for (let n = 0; n < 5; n++) {
            result = await child(
              scenario === "timeout" ? at(12) : "2026-01-10T04:00:00.000Z",
            );
            states.push(result.state);
            if (["completed", "rolled_back"].includes(result.state)) break;
          }
          assert.equal(
            result.state,
            scenario === "retain" ? "completed" : "rolled_back",
          );
          assert.deepEqual(
            (await registry.current()).artifact,
            scenario === "retain" ? correct : original,
          );
          const served = await post("/tickets", {
            id: "after-cycle",
            input: { text: "refund invoice", partition: "production" },
            startedAt: at(12),
          });
          assert.equal(
            served.output,
            scenario === "retain" ? "billing" : "access",
            "HTTP inference must use retained/restored version",
          );
        }
        const executions = await all(loop, "executions"),
          signals = await all(loop, "signals");
        assert.equal(
          signals.length,
          ["reject", "timeout"].includes(scenario) ? 92 : 104,
        );
        const receipts = (
          await pool.query(
            "SELECT receipt FROM loopiter_example_receipts WHERE scope=$1 AND receipt IS NOT NULL",
            [registry.scope],
          )
        ).rows;
        assert.equal(
          receipts.length,
          scenario === "reject" ? 0 : scenario === "retain" ? 1 : 2,
        );
        evidence.scenarios.push({
          scenario,
          finalState: result.state,
          states,
          executions: executions.length,
          uniqueSignals: signals.length,
          quarantinedEpisodes: 1,
          receipts: receipts.length,
          initialVersion: initial.version,
          finalVersion: (await registry.current()).version,
          runs: await all(loop, "runs"),
          candidates: await all(loop, "candidates"),
          observations: await all(loop, "observations"),
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    const report = process.env.LOOPITER_MOCK_REPORT;
    if (report)
      await writeFile(report, JSON.stringify(evidence, null, 2) + "\n", {
        flag: "wx",
      });
    console.log(
      JSON.stringify(
        {
          passed: true,
          scenarios: evidence.scenarios.map(
            ({
              scenario,
              finalState,
              executions,
              uniqueSignals,
              receipts,
            }) => ({
              scenario,
              finalState,
              executions,
              uniqueSignals,
              receipts,
            }),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    // Delete only this invocation's random namespaces and application registry scopes.
    for (const { ns, registry } of scopes) {
      await store.deleteNamespace(ns);
      for (const table of [
        "loopiter_example_receipts",
        "loopiter_example_targets",
        "loopiter_example_artifacts",
      ])
        await pool.query(`DELETE FROM ${table} WHERE scope=$1`, [
          registry.scope,
        ]);
    }
  }
}
try {
  if (process.argv[2] === "worker") await worker();
  else await lab();
} finally {
  await pool.end();
}
