import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "loopiter-package-"));
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with exit ${result.status}`);
}
try {
  // pack invokes prepack: a clean checkout must not rely on stale dist output.
  run("npm", ["pack", "--pack-destination", temporary], root);
  const tarballs = (await readdir(temporary)).filter((name) =>
    name.endsWith(".tgz"),
  );
  assert.equal(tarballs.length, 1);
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({
      name: "loopiter-clean-consumer",
      private: true,
      type: "module",
    }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve(temporary, tarballs[0]),
      "typescript@5.9.3",
      "@types/node@24",
    ],
    temporary,
  );
  const installed = JSON.parse(
    await readFile(
      join(temporary, "node_modules/loopiter/package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.version, "0.3.0-alpha.1");
  assert.equal(installed.license, "MIT");
  assert.equal(installed.bin?.loopiter, "dist/src/cli.js");
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
  assert.match(
    await readFile(join(temporary, "node_modules/loopiter/LICENSE"), "utf8"),
    /MIT License/,
  );
  await assert.rejects(
    readFile(join(temporary, "node_modules/pg/package.json")),
  );
  const fixture = JSON.parse(
    await readFile(join(root, "python/tests/fixtures/autonomy.json"), "utf8"),
  );
  await writeFile(
    join(temporary, "consumer.mts"),
    `
import { FeedbackLoop, InMemoryStore, ImprovementController, type ImprovementWorkflow } from 'loopiter';
import { PostgresStore, migratePostgres } from 'loopiter/postgres';
import { runStoreConformance } from 'loopiter/testing';
const store = new InMemoryStore();
let now = new Date('2026-02-01T00:00:00Z');
const loop = new FeedbackLoop({ store, namespace: 'tarball', clock: () => now });
await loop.recordExecution({ id: 'installed', kind: 'prediction' });
if ((await loop.getExecution('installed'))?.revision !== 1) throw new Error('Bad capture');
if ((await runStoreConformance(store)).length !== 9) throw new Error('Bad conformance');
let migrated = false;
const pool = { connect: async () => ({ query: async (sql: string) => { migrated = sql.includes('feloop_records'); return { rows: [], rowCount: 0 }; }, release() {} }) };
new PostgresStore(pool);
if (migrated) throw new Error('Construction migrated');
await migratePostgres(pool);
if (!migrated) throw new Error('Packaged migration missing');
let version = 'baseline';
const rows = (name: string, count: number, day: number) => Array.from({ length: count }, (_, i) => ({
  id: name + i, episodeId: name + i, entityId: name + i,
  occurredAt: '2026-01-0' + day + 'T00:00:00Z', observedAt: '2026-01-0' + day + 'T01:00:00Z',
  input: 'synthetic', label: 'yes', source: 'verified-human',
}));
const workflow: ImprovementWorkflow = {
  id: 'installed-cycle', version: '1', optimizerVersion: '1', evaluatorVersion: '1',
  policy: ${JSON.stringify(fixture.policy)},
  artifact: async () => ({ artifactVersion: version, configurationHash: 'fixed' }),
  dataset: async () => ({ version: '1', optimization: rows('o', 3, 1), validation: rows('v', 20, 2), audit: rows('a', 50, 3) }),
  propose: async () => [{ score: 1 }],
  evaluate: async ({ examples }) => ({ cases: examples.map(r => ({ id: r.id, baseline: 0, candidate: 1 })), metrics: { errors: 0 }, estimatedServingCost: 0 }),
  deployment: {
    apply: async ({ attempt, candidate }) => {
      if (version !== attempt.expectedArtifactVersion) throw Error('stale');
      const previousArtifactVersion = version;
      version = candidate.contentHash;
      return { attemptId: attempt.id, artifactVersion: version, previousArtifactVersion };
    },
    inspect: async () => ({ status: 'unknown' }),
    rollback: async () => { throw Error('Not exercised by this isolated package smoke'); },
  },
  observe: async input => ({ artifactVersion: version, configurationHash: 'fixed', startedAt: input.deployedAt,
    endedAt: now.toISOString(), complete: true, unitIds: Array.from({ length: 10 }, (_, i) => 'production-' + i), metrics: { errors: 0 } }),
};
const disabled = new ImprovementController(loop, { workflows: [workflow], mode: 'autonomous' });
if ((await disabled.tick(workflow.id)).reason !== 'self_improvement_disabled') throw Error('Unsafe default');
const controller = new ImprovementController(loop, { workflows: [workflow], mode: 'autonomous', selfImproving: true });
let state = '';
for (let i = 0; i < 6; i++) {
  const result = await controller.tick(workflow.id);
  state = result.state;
  if (state === 'completed') break;
  if (state === 'observing') now = new Date(now.getTime() + 7200000);
}
if (state !== 'completed' || version === 'baseline') throw Error('Installed autonomous cycle failed');
await loop.close();
console.log('Clean installed tarball: declarations, capture, conformance, migrations, safe defaults and simulated autonomous cycle passed.');
`,
  );
  run(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "consumer.mts",
      "--outDir",
      "built",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
    ],
    temporary,
  );
  run(process.execPath, ["built/consumer.mjs"], temporary);
  run(process.execPath, ["node_modules/.bin/loopiter", "--help"], temporary);
} finally {
  // Only the exact temporary consumer directory created by this script is removed.
  await rm(temporary, { recursive: true, force: true });
}
