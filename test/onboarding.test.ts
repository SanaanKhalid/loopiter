import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  initializeSelfHosted,
  inspectSelfHostedSetup,
  parseStepTimeout,
  readAgentGuide,
  readReference,
  readWorkerSettings,
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
    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.preset, "autonomous-default");
    assert.equal(plan.mode, "autonomous");
    assert.equal(plan.selfImproving, true);
    assert.deepEqual(Object.keys(plan).sort(), [
      "applicationModule",
      "audit",
      "language",
      "mode",
      "namespace",
      "preset",
      "requiredEnvironment",
      "reviewed",
      "schemaVersion",
      "selfImproving",
      "stepTimeoutMs",
      "storage",
    ]);
    assert.equal(setup.mode, "autonomous");
    assert.equal(setup.selfImproving, true);
    const readme = await readFile(join(destination, "README.md"), "utf8");
    assert.match(readme, /--enable --mode autonomous --once/);
    assert.match(readme, /--enable --mode recommend --once/);
    assert.match(
      readme,
      /--enable authorizes improvement work and provider spending/,
    );
    assert.match(
      readme,
      /fails closed without an audit partition, a budget, or --enable/,
    );
    assert.match(readme, /Omitting --mode uses plan.mode/);
    assert.match(readme, /The --mode flag overrides the plan/);
    const confirmation =
      "Before the first run with --enable --mode autonomous, stop and get explicit confirmation from the human. That confirmation is one-time, for initial activation and spend. A completed checklist, doctor report, or plan output alone is not confirmation. After that one confirmation, autonomous runs continue without per-candidate approval.";
    assert.ok(readme.includes(confirmation));
    assert.ok((await readAgentGuide()).includes(confirmation));
    assert.ok(
      readme.indexOf(confirmation) <
        readme.indexOf("--enable --mode autonomous --once"),
    );
    assert.ok(
      readme.indexOf("--enable --mode autonomous --once") <
        readme.indexOf("--enable --mode recommend --once"),
    );
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

test("init appends .state/ to an existing gitignore once", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-gitignore-"));
  try {
    const repoIgnore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
    assert.match(repoIgnore, /^\.state\/$/m);
    const destination = join(root, "existing");
    await mkdir(destination);
    await writeFile(join(destination, ".gitignore"), "dist");
    await writeFile(join(destination, "user-owned.txt"), "keep");
    await assert.rejects(initializeSelfHosted(destination), { code: "EEXIST" });
    const once = await readFile(join(destination, ".gitignore"), "utf8");
    assert.equal(once, "dist\n.state/\n");
    await assert.rejects(initializeSelfHosted(destination), { code: "EEXIST" });
    assert.equal(await readFile(join(destination, ".gitignore"), "utf8"), once);
    assert.equal(await readFile(join(destination, "user-owned.txt"), "utf8"), "keep");
    const already = join(root, "already");
    await mkdir(already);
    await writeFile(join(already, ".gitignore"), "# .state/\n!.state/\n/.state/\n");
    await assert.rejects(initializeSelfHosted(already), { code: "EEXIST" });
    assert.equal(
      await readFile(join(already, ".gitignore"), "utf8"),
      "# .state/\n!.state/\n/.state/\n",
    );
    const commented = join(root, "commented");
    await mkdir(commented);
    await writeFile(join(commented, ".gitignore"), "# .state/\n");
    await assert.rejects(initializeSelfHosted(commented), { code: "EEXIST" });
    assert.equal(await readFile(join(commented, ".gitignore"), "utf8"), "# .state/\n.state/\n");
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
    assert.equal(report.mode, "autonomous");
    assert.equal(report.selfImproving, true);
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

test("schemaVersion 1 plans stay recommend and are not rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-v1-"));
  try {
    const destination = join(root, "legacy");
    await initializeSelfHosted(destination);
    const path = join(destination, "integration-plan.json");
    const legacy = {
      schemaVersion: 1,
      language: "node",
      mode: "recommend",
      selfImproving: false,
      namespace: "app/legacy",
      applicationModule: "./application.mjs",
      storage: "postgres",
      requiredEnvironment: [],
      reviewed: {
        target: true,
        feedback: true,
        evaluation: true,
        budgets: true,
        deployment: true,
      },
    };
    const body = JSON.stringify(legacy, null, 2) + "\n";
    await writeFile(path, body);
    await writeFile(join(destination, "application.mjs"), "export {};\n");
    const report = await inspectSelfHostedSetup(destination, {});
    assert.equal(report.configured, true);
    assert.equal(report.mode, "recommend");
    assert.equal(report.selfImproving, false);
    assert.equal(await readFile(path, "utf8"), body);
    legacy.schemaVersion = 3;
    await writeFile(path, JSON.stringify(legacy));
    await assert.rejects(inspectSelfHostedSetup(destination), /schemaVersion 1 or 2/);
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

test("doctor refuses an audit that cannot certify and plan.mode is honored", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-audit-mode-"));
  try {
    const destination = join(root, "setup");
    await initializeSelfHosted(destination);
    const path = join(destination, "integration-plan.json");
    const plan = JSON.parse(await readFile(path, "utf8"));
    Object.assign(plan, {
      namespace: "app/dev",
      storage: "postgres",
      requiredEnvironment: [],
      reviewed: Object.fromEntries(
        Object.keys(plan.reviewed).map((key) => [key, true]),
      ),
    });
    await writeFile(join(destination, "application.mjs"), "export {};\n");
    plan.audit.minimumUnits = 5;
    await writeFile(path, JSON.stringify(plan));
    const blocked = await inspectSelfHostedSetup(destination, {});
    assert.equal(blocked.configured, false);
    assert.match(blocked.missing.join("\n"), /At least 7 units are required/);
    plan.mode = "recommend";
    await writeFile(path, JSON.stringify(plan));
    const warned = await inspectSelfHostedSetup(destination, {});
    assert.equal(warned.configured, true);
    assert.match(warned.warnings.join("\n"), /At least 7 units are required/);
    const module = join(root, "application.mjs");
    await writeFile(
      join(root, "integration-plan.json"),
      JSON.stringify({
        ...plan,
        mode: "autonomous",
        audit: { ...plan.audit, minimumUnits: 50 },
        stepTimeoutMs: 180000,
      }),
    );
    await writeFile(module, "export {};\n");
    const fromPlan = readWorkerSettings(module);
    assert.equal(fromPlan.mode, "autonomous");
    assert.equal(fromPlan.modeSource, "plan");
    assert.equal(fromPlan.stepTimeoutMs, 180000);
    assert.equal(fromPlan.stepTimeoutSource, "plan");
    const flagged = readWorkerSettings(module, {
      mode: "recommend",
      modeSource: "flag",
      stepTimeoutMs: 90000,
      stepTimeoutSource: "flag",
    });
    assert.equal(flagged.mode, "recommend");
    assert.equal(flagged.modeSource, "flag");
    assert.equal(flagged.stepTimeoutMs, 90000);
    const guide = await readAgentGuide();
    assert.match(guide, /stepTimeoutMs >= 1000/);
    assert.match(guide, /minimumCertifiableAuditUnits/);
    const cli = new URL("../src/cli.js", import.meta.url);
    const entry = new URL("../src/index.js", import.meta.url).href;
    const policy = JSON.parse(
      await readFile(
        new URL("../../python/tests/fixtures/autonomy.json", import.meta.url),
        "utf8",
      ),
    ).policy;
    await writeFile(
      module,
      `
import { FeedbackLoop, InMemoryStore } from ${JSON.stringify(entry)};
export async function createIntegration() {
 const loop = new FeedbackLoop({ store: new InMemoryStore(), namespace: 'cli/confirm' });
 const policy = ${JSON.stringify(policy)};
 const rows = (prefix, count, day) => Array.from({length: count}, (_, i) => ({id: prefix+i, episodeId: prefix+i, entityId: prefix+i, occurredAt: '2026-01-0'+day+'T00:00:00Z', observedAt: '2026-01-0'+day+'T01:00:00Z', source: policy.trustedSources[0], input:'test', label:'yes'}));
 const workflow = {id:'cli', version:'1', optimizerVersion:'1', evaluatorVersion:'1', policy,
  artifact: async()=>({artifactVersion:'baseline',configurationHash:'fixed'}),
  dataset: async()=>({version:'1',optimization:rows('o',3,1),validation:rows('v',20,2),audit:rows('a',50,3)}),
  propose: async()=>[{score:1}],
  evaluate: async({examples})=>({cases:examples.map((row)=>({id:row.id,baseline:0,candidate:1})),metrics:{errors:0},estimatedServingCost:0}),
  deployment:{apply:async()=>{throw Error('not this test')},rollback:async()=>{throw Error('no')},inspect:async()=>({status:'unknown'})},
  observe:async()=>{throw Error('no')}};
 return {loop, workflows:[workflow], close:async()=>{await loop.close();}};
}
`,
    );
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cli.pathname, ...args], {
        cwd: root,
        encoding: "utf8",
        input: "",
      });
    const denied = run([
      "worker",
      "--module",
      module,
      "--enable",
      "--mode",
      "autonomous",
      "--once",
    ]);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /--confirm-activation or --yes/);
    const allowed = run([
      "worker",
      "--module",
      module,
      "--enable",
      "--confirm-activation",
      "--once",
      "--step-timeout-ms",
      "180000",
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /effective mode autonomous \(source: plan\)/);
    assert.match(allowed.stderr, /effective step timeout 180000ms \(source: flag\)/);
    assert.match(allowed.stdout, /"state":"evaluating"/);
    const again = run(["worker", "--module", module, "--enable", "--once"]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /one-time confirmation/);
    const stamp = JSON.parse(
      await readFile(join(root, ".state", "activation.json"), "utf8"),
    ) as {
      entries: Record<string, { planHash: string; confirmedBy: string; confirmedAt: string }>;
    };
    assert.match(stamp.entries["app/dev"]!.confirmedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(stamp.entries["app/dev"]!.confirmedBy.trim());
    assert.equal(stamp.entries["app/dev"]!.planHash.length, 64);
    const planPath = join(root, "integration-plan.json");
    const storedPlan = JSON.parse(await readFile(planPath, "utf8"));
    storedPlan.budget = { tokens: 1000 };
    await writeFile(planPath, JSON.stringify(storedPlan));
    const changedBudget = run(["worker", "--module", module, "--enable", "--once"]);
    assert.equal(changedBudget.status, 1);
    assert.match(changedBudget.stderr, /one-time confirmation/);
    delete storedPlan.budget;
    storedPlan.namespace = "app/other";
    await writeFile(planPath, JSON.stringify(storedPlan));
    const freshNamespace = run(["worker", "--module", module, "--enable", "--once"]);
    assert.equal(freshNamespace.status, 1);
    assert.match(freshNamespace.stderr, /one-time confirmation/);
    storedPlan.namespace = "app/dev";
    storedPlan.audit.minimumUnits = 60;
    await writeFile(planPath, JSON.stringify(storedPlan));
    const changedAudit = run(["worker", "--module", module, "--enable", "--once"]);
    assert.equal(changedAudit.status, 1);
    assert.match(changedAudit.stderr, /one-time confirmation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("step timeout accepts only decimal integers", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopiter-timeout-"));
  const cli = new URL("../src/cli.js", import.meta.url);
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli.pathname, ...args], {
      cwd: root,
      encoding: "utf8",
      input: "",
    });
  try {
    for (const value of ["1e5", "120000.0", "0x1e240"]) {
      const result = run([
        "worker",
        "--module",
        "missing.mjs",
        "--enable",
        "--step-timeout-ms",
        value,
        "--once",
      ]);
      assert.equal(result.status, 1, value);
      assert.match(result.stderr, /decimal integer/);
      assert.throws(() => parseStepTimeout(value), /decimal integer/);
    }
    assert.equal(parseStepTimeout("120000"), 120000);
    const module = join(root, "application.mjs");
    await writeFile(module, "export {};\n");
    for (const literal of ["1e5", "120000.0"]) {
      await writeFile(
        join(root, "integration-plan.json"),
        `{"schemaVersion":2,"language":"node","mode":"recommend","selfImproving":false,"namespace":"app/dev","stepTimeoutMs":${literal}}\n`,
      );
      assert.throws(() => readWorkerSettings(module), /decimal integer/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
