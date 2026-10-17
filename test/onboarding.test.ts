import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  initializeSelfHosted,
  inspectSelfHostedSetup,
  readAgentGuide,
  readReference,
  runSelfHostedWorker,
  verifySelfHostedInstallation,
} from "../src/onboarding.js";

test("self-hosted init never overwrites user files or follows an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter onboarding "));
  try {
    const destination = join(root, "my app");
    const setup = await initializeSelfHosted(destination);
    assert.equal(setup.connected, false);
    assert.equal(
      await readFile(join(destination, "AGENT_GUIDE.md"), "utf8"),
      await readAgentGuide(),
    );
    const plan = JSON.parse(
      await readFile(join(destination, "integration-plan.json"), "utf8"),
    );
    assert.equal(plan.selfImproving, false);
    assert.equal(plan.mode, "recommend");
    await writeFile(join(destination, "user-owned.txt"), "preserve me");
    await assert.rejects(initializeSelfHosted(destination), { code: "EEXIST" });
    assert.equal(
      await readFile(join(destination, "user-owned.txt"), "utf8"),
      "preserve me",
    );
    const alias = join(root, "existing-link");
    await symlink(destination, alias, "dir");
    await assert.rejects(initializeSelfHosted(alias), { code: "EEXIST" });
    const dangling = join(root, "dangling");
    await symlink(join(root, "must-not-be-created"), dangling, "dir");
    await assert.rejects(initializeSelfHosted(dangling), { code: "EEXIST" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor checks configuration without executing the module or exposing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-doctor-"));
  try {
    const destination = join(root, "setup");
    await initializeSelfHosted(destination);
    assert.equal(
      (await inspectSelfHostedSetup(destination, {})).configured,
      false,
    );
    const path = join(destination, "integration-plan.json");
    const plan = JSON.parse(await readFile(path, "utf8"));
    Object.assign(plan, {
      namespace: "app/dev",
      storage: "postgres",
      requiredEnvironment: ["APP_MODEL_KEY"],
      reviewed: Object.fromEntries(
        Object.keys(plan.reviewed).map((key) => [key, true]),
      ),
    });
    await writeFile(path, JSON.stringify(plan));
    await writeFile(
      join(destination, "application.mjs"),
      "throw Error('doctor must not import application code');\n",
    );
    const missingKey = await inspectSelfHostedSetup(destination, {});
    assert.equal(missingKey.configured, false);
    const report = await inspectSelfHostedSetup(destination, {
      APP_MODEL_KEY: "private-test-sentinel",
    });
    assert.equal(report.configured, true);
    assert.equal(report.liveVerified, false);
    assert.ok(!JSON.stringify(report).includes("private-test-sentinel"));
    plan.requiredEnvironment = ["secret-value-with-punctuation!"];
    await writeFile(path, JSON.stringify(plan));
    await assert.rejects(
      inspectSelfHostedSetup(destination),
      /names, never values/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline verification exercises measured acceptance, rejection, recovery and rollback without fetch", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("Offline verification attempted network access");
  };
  try {
    const report = await verifySelfHostedInstallation();
    assert.equal(report.providerCalls, 0);
    assert.equal(report.checks.length, 5);
    assert.ok(report.checks.every((check) => check.passed));
    assert.match(report.evidence, /SIMULATED/);
  } finally {
    globalThis.fetch = fetch;
  }
  assert.match(await readReference("workflows"), /promptWorkflow/);
  await assert.rejects(readReference("../../.env"), /Unknown reference/);
});

test("worker requires opt-in before importing local application code", async () => {
  await assert.rejects(
    runSelfHostedWorker({
      module: "/does-not-exist.mjs",
      mode: "autonomous",
      once: true,
    }),
    /disabled/,
  );
  await assert.rejects(
    runSelfHostedWorker({
      module: "/does-not-exist.mjs",
      selfImproving: true,
      intervalMs: 0,
    }),
    /intervalMs/,
  );
  await assert.rejects(
    runSelfHostedWorker({
      module: "/does-not-exist.mjs",
      selfImproving: true,
      mode: "typo" as never,
    }),
    /Invalid improvement mode/,
  );
  await assert.rejects(
    runSelfHostedWorker({
      module: "/does-not-exist.mjs",
      selfImproving: true,
      signal: AbortSignal.abort(),
    }),
  );
});

test("worker advances a real SDK workflow in recommend mode and cleans up on errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-worker-"));
  try {
    const entry = new URL("../src/index.js", import.meta.url).href;
    const policy = JSON.parse(
      await readFile(
        new URL("../../python/tests/fixtures/autonomy.json", import.meta.url),
        "utf8",
      ),
    ).policy;
    const module = join(root, "application.mjs");
    await writeFile(
      module,
      `
import { FeedbackLoop, InMemoryStore } from ${JSON.stringify(entry)};
export const observed = { applied: 0, closed: 0 };
export async function createIntegration() {
 const loop = new FeedbackLoop({ store: new InMemoryStore(), namespace: 'worker/check' });
 const policy = ${JSON.stringify(policy)};
 const rows = (prefix, count, day) => Array.from({length: count}, (_, i) => ({id: prefix+i, episodeId: prefix+i, entityId: prefix+i, occurredAt: '2026-01-0'+day+'T00:00:00Z', observedAt: '2026-01-0'+day+'T01:00:00Z', source: policy.trustedSources[0], input:'test', label:'yes'}));
 const workflow = {id:'worker-test', version:'1', optimizerVersion:'1', evaluatorVersion:'1', policy,
 artifact: async()=>({artifactVersion:'baseline',configurationHash:'fixed'}),
 dataset: async()=>({version:'1',optimization:rows('o',3,1),validation:rows('v',20,2),audit:rows('a',50,3)}),
 propose: async()=>[{score:1}],
 evaluate: async({examples})=>({cases:examples.map(row=>({id:row.id,baseline:0,candidate:1})),metrics:{errors:0},estimatedServingCost:0}),
 deployment:{apply:async()=>{observed.applied++;throw Error('recommend must not apply');},rollback:async()=>{throw Error('unexpected rollback');},inspect:async()=>({status:'unknown'})},
 observe:async()=>{throw Error('recommend must not observe a deployment');}};
 return {loop, workflows:[workflow], close:async()=>{observed.closed++;await loop.close();}};
}
`,
    );
    const results = await runSelfHostedWorker({
      module,
      selfImproving: true,
      once: true,
    });
    assert.equal(results.length, 1);
    const loaded = await import(pathToFileURL(module).href);
    assert.equal(loaded.observed.applied, 0);
    assert.equal(loaded.observed.closed, 1);
    const invalid = join(root, "invalid.mjs");
    await writeFile(
      invalid,
      `import { FeedbackLoop, InMemoryStore } from ${JSON.stringify(entry)}; export let closed=false; export async function createIntegration(){return {loop:new FeedbackLoop({store:new InMemoryStore(),namespace:'invalid'}),workflows:[],close:async()=>{closed=true;}}}`,
    );
    await assert.rejects(
      runSelfHostedWorker({ module: invalid, selfImproving: true, once: true }),
      /Workflows required/,
    );
    assert.equal((await import(pathToFileURL(invalid).href)).closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI errors do not turn an unfinished setup into a successful connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-cli-"));
  const cli = new URL("../src/cli.js", import.meta.url);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli.pathname, ...args], {
      cwd: root,
      encoding: "utf8",
    });
  try {
    assert.equal(run("init", "--directory", "setup").status, 0);
    const result = run("doctor", "--directory", "setup");
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).configured, false);
    assert.equal(run("init", "--directory", "setup").status, 1);
    assert.equal(run("init", "--directory").status, 1);
    assert.equal(run("init", "--direcotry", "typo").status, 1);
    assert.equal(
      run("init", "--directory", "one", "--directory", "two").status,
      1,
    );
    assert.equal(run("worker", "--help").status, 0);
    assert.equal(
      run("worker", "--module", "absent.mjs", "--mode", "autonomous").status,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
