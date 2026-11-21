import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hotpotTask } from "../benchmarks/hotpotqa/task.js";
import { ifbenchTask } from "../benchmarks/ifbench/task.js";
import {
  fixtureEvalLockPath,
  fixtureTrainSuitePath,
  guardEvalSuite,
  suiteFromTask,
} from "../benchmarks/public/eval-lock.js";
import { runLiveTask } from "../benchmarks/public/live.js";
import { runOfflineBenchmark } from "../benchmarks/public/harness.js";
import { resolveLimits } from "../benchmarks/public/limits.js";
import type { BenchmarkTask, PublicExample } from "../benchmarks/public/task.js";
import {
  FeedbackLoop,
  InMemoryStore,
  ImprovementController,
  checkEvalLeakage,
  lockEvalSet,
  prepareDataset,
  verifyEvalLock,
  type AutonomyPolicy,
  type DatasetSnapshot,
  type EvalSuite,
  type ImprovementWorkflow,
} from "../src/index.js";
import { Registry } from "./helpers.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pythonEnv = { ...process.env, PYTHONPATH: join(root, "python/src") };

const rich: EvalSuite = {
  items: [
    {
      id: "b",
      input: { z: 1, a: "caf\u00e9" },
      expected: "plain",
    },
    {
      id: "a\u0301",
      input: { text: "line\n\u007f\u202e" },
      expected: 1,
    },
    {
      id: "c\u{1F600}",
      input: ["  spaced \t", 0.1],
      expected: { n: 1.0, ok: true, nil: null },
    },
  ],
};

test("the eval checksum is stable across runs and key order", () => {
  const first = lockEvalSet(rich);
  const second = lockEvalSet({
    items: [...rich.items].reverse().map((item) => ({
      id: item.id,
      expected: item.expected,
      input:
        item.input && typeof item.input === "object" && !Array.isArray(item.input)
          ? Object.fromEntries(Object.entries(item.input).reverse())
          : item.input,
    })),
  });
  assert.equal(first.scheme, 1);
  assert.equal(first.itemCount, 3);
  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(
    first.items.map((item) => item.id),
    ["a\u0301", "b", "c\u{1F600}"].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );
  assert.equal(verifyEvalLock(rich, first).ok, true);
});

test("verify reports added, removed, and changed ids and a re-lock clears the drift", () => {
  const lock = lockEvalSet(rich);
  const added = verifyEvalLock(
    { items: [...rich.items, { id: "new", input: "n", expected: "n" }] },
    lock,
  );
  assert.equal(added.ok, false);
  assert.equal(added.added, 1);
  assert.equal(added.removed, 0);
  assert.equal(added.changed, 0);
  assert.deepEqual(added.addedIds, ["new"]);
  const removed = verifyEvalLock({ items: rich.items.slice(1) }, lock);
  assert.equal(removed.removed, 1);
  assert.equal(removed.added, 0);
  assert.equal(removed.changed, 0);
  const changed = verifyEvalLock(
    {
      items: rich.items.map((item) =>
        item.id === "b" ? { ...item, expected: "edited" } : item,
      ),
    },
    lock,
  );
  assert.equal(changed.changed, 1);
  assert.equal(changed.added, 0);
  assert.equal(changed.removed, 0);
  assert.deepEqual(changed.changedIds, ["b"]);
  assert.equal(changed.addedIds.join("") + changed.removedIds.join(""), "");
  const relocked = lockEvalSet({
    items: rich.items.map((item) => (item.id === "b" ? { ...item, expected: "edited" } : item)),
  });
  assert.notEqual(relocked.sha256, lock.sha256);
  assert.equal(
    verifyEvalLock(
      {
        items: rich.items.map((item) =>
          item.id === "b" ? { ...item, expected: "edited" } : item,
        ),
      },
      relocked,
    ).ok,
    true,
  );
});

test("leakage is exact on id and normalized content", () => {
  const train: EvalSuite = {
    items: [
      { id: "t-space", input: "a  b", expected: "cafe\u0301" },
      { id: "shared", input: "only-train", expected: "x" },
      { id: "t-case", input: "Hello", expected: "Y" },
    ],
  };
  const evaluation: EvalSuite = {
    items: [
      { id: "e-space", input: "a\u00a0b", expected: "caf\u00e9" },
      { id: "shared", input: "only-eval", expected: "y" },
      { id: "e-case", input: "hello", expected: "Z" },
      { id: "clean", input: "other", expected: "z" },
    ],
  };
  const hit = checkEvalLeakage(train, evaluation);
  assert.equal(hit.ok, false);
  assert.equal(hit.idOverlapCount, 1);
  assert.equal(hit.contentOverlapCount, 2);
  assert.equal(hit.overlapCount, 3);
  assert.deepEqual(hit.ids, ["e-space", "shared", "t-space"]);
  const inputOnly = checkEvalLeakage(train, evaluation, ["input"]);
  assert.equal(inputOnly.idOverlapCount, 1);
  assert.equal(inputOnly.contentOverlapCount, 2);
  const expectedOnly = checkEvalLeakage(train, evaluation, ["expected"]);
  assert.equal(expectedOnly.contentOverlapCount, 2);
  assert.equal(expectedOnly.ids.includes("e-case"), false);
  const miss = checkEvalLeakage(
    { items: [{ id: "t", input: "alpha", expected: "one" }] },
    { items: [{ id: "e", input: "beta", expected: "two" }] },
  );
  assert.equal(miss.ok, true);
  assert.equal(miss.overlapCount, 0);
  assert.deepEqual(miss.ids, []);
  const many = {
    items: Array.from({ length: 21 }, (_, index) => ({
      id: `id-${String(index).padStart(2, "0")}`,
      input: "same",
      expected: "same",
    })),
  };
  const capped = checkEvalLeakage(many, many);
  assert.equal(capped.overlapCount, 21);
  assert.equal(capped.truncated, true);
  assert.equal(capped.ids.length, 20);
});

test("cli output and exit codes match across the sdks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-lock-"));
  try {
    const suite = join(directory, "suite.json");
    const train = join(directory, "train.json");
    const evaluation = join(directory, "eval.json");
    await writeFile(suite, `${JSON.stringify(rich)}\n`);
    await writeFile(
      train,
      `${JSON.stringify({
        items: [
          { id: "t", input: "a   b", expected: "cafe\u0301" },
          { id: "u", input: "unique", expected: "no" },
        ],
      })}\n`,
    );
    await writeFile(
      evaluation,
      `${JSON.stringify({
        items: [
          { id: "e", input: "a b", expected: "caf\u00e9" },
          { id: "v", input: "other", expected: "no" },
        ],
      })}\n`,
    );
    const nodeOut = join(directory, "node.lock.json");
    const pythonOut = join(directory, "python.lock.json");
    const nodeLock = cli(["eval", "lock", suite, "--out", nodeOut]);
    const pythonLock = py(["eval", "lock", suite, "--out", pythonOut]);
    assert.equal(nodeLock.status, 0, nodeLock.stderr);
    assert.equal(pythonLock.status, nodeLock.status);
    assert.equal(pythonLock.stderr, nodeLock.stderr);
    assert.equal(pythonLock.stdout.replaceAll(pythonOut, nodeOut), nodeLock.stdout);
    assert.equal(await readFile(nodeOut, "utf8"), await readFile(pythonOut, "utf8"));
    const nodeVerify = cli(["eval", "verify", suite, "--lock", nodeOut]);
    const pythonVerify = py(["eval", "verify", suite, "--lock", pythonOut]);
    assert.equal(nodeVerify.status, 0, nodeVerify.stderr);
    assert.equal(pythonVerify.stdout, nodeVerify.stdout);
    assert.equal(pythonVerify.status, 0);
    const drifted = join(directory, "drift.json");
    const parsed = JSON.parse(await readFile(suite, "utf8")) as EvalSuite;
    parsed.items.push({ id: "added", input: "z", expected: "z" });
    await writeFile(drifted, `${JSON.stringify(parsed)}\n`);
    const nodeDrift = cli(["eval", "verify", drifted, "--lock", join(directory, "node.lock.json")]);
    const pythonDrift = py(["eval", "verify", drifted, "--lock", join(directory, "node.lock.json")]);
    assert.equal(nodeDrift.status, 1);
    assert.equal(pythonDrift.status, 1);
    assert.equal(pythonDrift.stdout, nodeDrift.stdout);
    assert.equal(pythonDrift.stderr, "");
    assert.match(nodeDrift.stdout, /added 1 removed 0 changed 0/);
    assert.equal(nodeDrift.stdout.includes("input"), false);
    const nodeJson = cli(["eval", "verify", drifted, "--lock", join(directory, "node.lock.json"), "--json"]);
    const pythonJson = py(["eval", "verify", drifted, "--lock", join(directory, "node.lock.json"), "--json"]);
    assert.equal(pythonJson.stdout, nodeJson.stdout);
    assert.equal([...nodeJson.stdout].every((character) => character.charCodeAt(0) <= 127), true);
    const report = JSON.parse(nodeJson.stdout) as { added: number; addedIds: string[] };
    assert.equal(report.added, 1);
    assert.deepEqual(report.addedIds, ["added"]);
    const relock = cli(["eval", "lock", drifted, "--out", join(directory, "node.lock.json")]);
    assert.equal(relock.status, 0, relock.stderr);
    assert.equal(cli(["eval", "verify", drifted, "--lock", join(directory, "node.lock.json")]).status, 0);
    const nodeLeak = cli(["eval", "leakage", "--train", train, "--eval", evaluation]);
    const pythonLeak = py(["eval", "leakage", "--train", train, "--eval", evaluation]);
    assert.equal(nodeLeak.status, 1);
    assert.equal(pythonLeak.status, 1);
    assert.equal(pythonLeak.stdout, nodeLeak.stdout);
    assert.match(nodeLeak.stdout, /count 2/);
    const nodeMiss = cli(["eval", "leakage", "--train", train, "--eval", evaluation, "--fields", "expected"]);
    const pythonMiss = py(["eval", "leakage", "--train", train, "--eval", evaluation, "--fields", "expected"]);
    assert.equal(nodeMiss.status, 1);
    assert.equal(pythonMiss.stdout, nodeMiss.stdout);
    const cleanTrain = join(directory, "clean-train.json");
    const cleanEval = join(directory, "clean-eval.json");
    await writeFile(cleanTrain, `${JSON.stringify({ items: [{ id: "t", input: "a", expected: "b" }] })}\n`);
    await writeFile(cleanEval, `${JSON.stringify({ items: [{ id: "e", input: "c", expected: "d" }] })}\n`);
    const nodeClean = cli(["eval", "leakage", "--train", cleanTrain, "--eval", cleanEval, "--json"]);
    const pythonClean = py(["eval", "leakage", "--train", cleanTrain, "--eval", cleanEval, "--json"]);
    assert.equal(nodeClean.status, 0, nodeClean.stderr);
    assert.equal(pythonClean.status, 0, pythonClean.stderr);
    assert.equal(pythonClean.stdout, nodeClean.stdout);
    assert.equal([...nodeClean.stdout].every((character) => character.charCodeAt(0) <= 127), true);
    const usage = cli(["eval", "verify"]);
    const pythonUsage = py(["eval", "verify"]);
    assert.equal(usage.status, 2);
    assert.equal(pythonUsage.status, 2);
    assert.equal(pythonUsage.stderr, usage.stderr);
    assert.equal(pythonUsage.stdout, "");
    const unknown = cli(["eval", "lock", suite, "--nope"]);
    const pythonUnknown = py(["eval", "lock", suite, "--nope"]);
    assert.equal(unknown.status, 2);
    assert.equal(pythonUnknown.stderr, unknown.stderr);
    const crafted = join(directory, "crafted.json");
    await writeFile(
      crafted,
      `${JSON.stringify({
        items: [{ id: "c\u007f\u202e\u00e9\n\u{1F600}", input: "x", expected: "y" }],
      })}\n`,
    );
    const craftedOut = join(directory, "crafted.lock.json");
    const craftedPythonOut = join(directory, "crafted-py.lock.json");
    const craftedNode = cli(["eval", "lock", crafted, "--out", craftedOut]);
    const craftedPython = py(["eval", "lock", crafted, "--out", craftedPythonOut]);
    assert.equal(craftedNode.status, 0, craftedNode.stderr);
    assert.equal(craftedPython.stdout.replaceAll(craftedPythonOut, craftedOut), craftedNode.stdout);
    assert.equal(await readFile(craftedOut, "utf8"), await readFile(craftedPythonOut, "utf8"));
    const craftedLeak = cli(["eval", "leakage", "--train", crafted, "--eval", crafted]);
    const craftedLeakPython = py(["eval", "leakage", "--train", crafted, "--eval", crafted]);
    assert.equal(craftedLeak.status, 1);
    assert.equal(craftedLeakPython.stdout, craftedLeak.stdout);
    assert.equal(craftedLeak.stdout.includes("\u007f"), false);
    assert.equal(craftedLeak.stdout.includes("\u202e"), false);
    assert.equal(craftedLeak.stdout.includes("\u{1F600}"), false);
    assert.match(craftedLeak.stdout, /\\u007f/);
    assert.match(craftedLeak.stdout, /\\u202e/);
    assert.match(craftedLeak.stdout, /\\u00e9/);
    assert.match(craftedLeak.stdout, /\\ud83d\\ude00/);
    const craftedJson = cli(["eval", "leakage", "--train", crafted, "--eval", crafted, "--json"]);
    const craftedJsonPython = py(["eval", "leakage", "--train", crafted, "--eval", crafted, "--json"]);
    assert.equal(craftedJsonPython.stdout, craftedJson.stdout);
    assert.equal([...craftedJson.stdout].every((character) => character.charCodeAt(0) <= 127), true);
    const craftedReport = JSON.parse(craftedJson.stdout) as { ids: string[] };
    assert.equal(craftedReport.ids[0], "c\u007f\u202e\u00e9\n\u{1F600}");
    const controls = "\u001c\u001d\u001e\u001f\u0085";
    const kept = join(directory, "kept.json");
    const stripped = join(directory, "stripped.json");
    await writeFile(
      kept,
      `${JSON.stringify({ items: [{ id: "k", input: `${controls}foo${controls}`, expected: "a" }] })}\n`,
    );
    await writeFile(
      stripped,
      `${JSON.stringify({ items: [{ id: "s", input: "foo", expected: "a" }] })}\n`,
    );
    const nodeControls = cli(["eval", "leakage", "--train", kept, "--eval", stripped, "--fields", "input", "--json"]);
    const pythonControls = py(["eval", "leakage", "--train", kept, "--eval", stripped, "--fields", "input", "--json"]);
    assert.equal(nodeControls.status, 0, nodeControls.stderr);
    assert.equal(pythonControls.status, 0, pythonControls.stderr);
    assert.equal(pythonControls.stdout, nodeControls.stdout);
    const proto = join(directory, "proto.json");
    const protoEdited = join(directory, "proto-edited.json");
    await writeFile(proto, '{"items":[{"id":"p","input":{"__proto__":{"edited":false},"keep":1},"expected":"ok"}]}\n');
    await writeFile(
      protoEdited,
      '{"items":[{"id":"p","input":{"__proto__":{"edited":true},"keep":1},"expected":"ok"}]}\n',
    );
    const nodeProto = cli(["eval", "lock", proto, "--out", join(directory, "proto.lock.json")]);
    const pythonProto = py(["eval", "lock", proto, "--out", join(directory, "proto-py.lock.json")]);
    assert.equal(nodeProto.status, 0, nodeProto.stderr);
    assert.equal(pythonProto.status, 0, pythonProto.stderr);
    assert.equal(
      await readFile(join(directory, "proto.lock.json"), "utf8"),
      await readFile(join(directory, "proto-py.lock.json"), "utf8"),
    );
    const nodeProtoDrift = cli([
      "eval",
      "verify",
      protoEdited,
      "--lock",
      join(directory, "proto.lock.json"),
      "--json",
    ]);
    const pythonProtoDrift = py([
      "eval",
      "verify",
      protoEdited,
      "--lock",
      join(directory, "proto.lock.json"),
      "--json",
    ]);
    assert.equal(nodeProtoDrift.status, 1);
    assert.equal(pythonProtoDrift.stdout, nodeProtoDrift.stdout);
    assert.equal(JSON.parse(nodeProtoDrift.stdout).changed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed eval rows stop the run before a model or evaluator call", async () => {
  const open = await controllerCase();
  assert.equal(open.datasetCalls > 0, true);
  assert.equal(open.proposals > 0, true);
  assert.equal(open.reason === "eval_lock_drift", false);
  const lock = lockEvalSet(evalRows(sampleDataset()));
  const matched = await controllerCase({ lock });
  assert.equal(matched.datasetCalls > 0, true);
  assert.equal(matched.proposals > 0, true);
  assert.equal(matched.evaluations, 0);
  const drifted = await controllerCase({
    lock,
    mutate: (data) => {
      data.validation[0]!.label = "changed-eval-label";
    },
  });
  assert.equal(drifted.datasetCalls, 1);
  assert.equal(drifted.proposals, 0);
  assert.equal(drifted.evaluations, 0);
  assert.equal(drifted.reason, "eval_lock_drift");
});

test("public benchmarks refuse a drifted eval split before any model call", async () => {
  let scores = 0;
  const task = {
    ...hotpotTask,
    fixtures: () => {
      const loaded = hotpotTask.fixtures();
      loaded.heldOut[0] = { ...loaded.heldOut[0]!, answer: "DRIFT" };
      return loaded;
    },
    scoreMany: async (items: Parameters<typeof hotpotTask.scoreMany>[0]) => {
      scores += items.length;
      return hotpotTask.scoreMany(items);
    },
  };
  await assert.rejects(
    () => runOfflineBenchmark(task, { seeds: [1], source: "fixtures" }),
    /Eval lock drift added 0 removed 0 changed 1/,
  );
  assert.equal(scores, 0);
  const original = hotpotTask.fixtures();
  const lock = lockEvalSet(suiteFromTask(hotpotTask, original.heldOut));
  const directory = await mkdtemp(join(tmpdir(), "eval-live-lock-"));
  let fetches = 0;
  try {
    const lockPath = join(directory, "drift.lock.json");
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`);
    const drifted = {
      ...original,
      heldOut: original.heldOut.map((row, index) =>
        index === 0 ? { ...row, answer: "DRIFT" } : row,
      ),
    };
    await assert.rejects(
      () =>
        runLiveTask(
          hotpotTask,
          {
            seeds: [1],
            smoke: true,
            deployment: "test",
            apiVersion: "v1",
            endpoint: "https://example.invalid/",
            apiKey: "secret",
            prices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
            totalCapUsd: 1,
            warnUsd: 1,
            invocationCapUsd: 1,
            stopAtWarn: false,
            ledgerPath: join(directory, "ledger.json"),
            limits: resolveLimits({}, hotpotTask),
            minimumImprovement: 0,
            maxTokensPerMinute: 0,
            maxRetryWaitMs: 1,
            max429Retries: 0,
            requestTimeoutMs: 1,
            maxTotalWaitMs: 1,
            stallTimeoutMs: 1,
            evalLockPath: lockPath,
            fetch: async () => {
              fetches += 1;
              return new Response("{}", { status: 200 });
            },
          },
          drifted,
        ),
      /Eval lock drift added 0 removed 0 changed 1/,
    );
    assert.equal(fetches, 0);
    guardEvalSuite(suiteFromTask(hotpotTask, original.heldOut), join(directory, "missing.lock.json"), true);
    assert.throws(
      () => guardEvalSuite(suiteFromTask(hotpotTask, original.heldOut), join(directory, "missing.lock.json")),
      /Missing eval lock/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed fixture eval locks match the checked-in splits", () => {
  assertFixtureLock(hotpotTask);
  assertFixtureLock(ifbenchTask);
});

function assertFixtureLock<T extends PublicExample>(task: BenchmarkTask<T>): void {
  const loaded = task.fixtures();
  const evaluation = suiteFromTask(task, loaded.heldOut);
  const train = suiteFromTask(task, loaded.pool);
  const lock = lockEvalSet(evaluation);
  const file = JSON.parse(readFileSync(fixtureEvalLockPath(task.id), "utf8")) as { sha256: string };
  assert.equal(file.sha256, lock.sha256);
  assert.equal(verifyEvalLock(evaluation, file).ok, true);
  const leakage = checkEvalLeakage(train, evaluation);
  assert.equal(leakage.ok, true);
  assert.equal(leakage.overlapCount, 0);
  const committedTrain = JSON.parse(readFileSync(fixtureTrainSuitePath(task.id), "utf8")) as EvalSuite;
  assert.equal(lockEvalSet(committedTrain).sha256, lockEvalSet(train).sha256);
}

function cli(args: string[]) {
    return spawnSync(process.execPath, [fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url)), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function py(args: string[]) {
  return spawnSync("python3", ["-m", "loopiter", ...args], {
    cwd: root,
    env: pythonEnv,
    encoding: "utf8",
  });
}

function evalRows(data: DatasetSnapshot): EvalSuite {
  const prepared = prepareDataset(
    data,
    JSON.parse(
      readFileSync(fileURLToPath(new URL("../../python/tests/fixtures/autonomy.json", import.meta.url)), "utf8"),
    ).policy as AutonomyPolicy,
    "2026-02-01T00:00:00.000Z",
  );
  return {
    items: [...prepared.validation, ...prepared.audit].map((row) => ({
      id: row.id,
      input: row.input,
      expected: row.label,
    })),
  };
}

async function controllerCase(options?: {
  lock?: ReturnType<typeof lockEvalSet>;
  mutate?: (data: DatasetSnapshot) => void;
}): Promise<{
  datasetCalls: number;
  artifactCalls: number;
  proposals: number;
  evaluations: number;
  reason: string;
}> {
  const policy = JSON.parse(
    await readFile(new URL("../../python/tests/fixtures/autonomy.json", import.meta.url), "utf8"),
  ).policy as AutonomyPolicy;
  let datasetCalls = 0;
  let artifactCalls = 0;
  let proposals = 0;
  let evaluations = 0;
  const data = sampleDataset();
  options?.mutate?.(data);
  const workflow: ImprovementWorkflow = {
    id: "classification",
    version: "1",
    optimizerVersion: "1",
    evaluatorVersion: "paired-v1",
    policy,
    artifact: async () => {
      artifactCalls += 1;
      return { artifactVersion: "v1", configurationHash: "model-v1" };
    },
    dataset: async () => {
      datasetCalls += 1;
      return data;
    },
    propose: async (_input, context) => {
      proposals += 1;
      return context.meter(100, async () => ({ value: [{ score: 0.9 }], tokens: 10 }));
    },
    evaluate: async () => {
      evaluations += 1;
      return { cases: [], metrics: { errors: 0 }, estimatedServingCost: 0 };
    },
    deployment: new Registry(),
    observe: async () => {
      throw new Error("observe is not part of this test");
    },
  };
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "eval-lock",
    clock: () => new Date("2026-02-01T00:00:00.000Z"),
  });
  const controller = new ImprovementController(loop, {
    mode: "autonomous",
    selfImproving: true,
    workflows: [workflow],
    ...(options?.lock ? { requireEvalLock: { lock: options.lock } } : {}),
  });
  const result = await controller.tick("classification");
  return { datasetCalls, artifactCalls, proposals, evaluations, reason: result.reason };
}

function sampleDataset(): DatasetSnapshot {
  const row = (name: string, index: number, day: number) => ({
    id: `customer-${name}-${index}`,
    episodeId: `ticket-${name}-${index}`,
    entityId: `person-${name}-${index}`,
    input: { text: "A customer correction" },
    label: "billing",
    source: "verified-human",
    occurredAt: `2026-01-0${day}T00:00:00.000Z`,
    observedAt: `2026-01-0${day}T01:00:00.000Z`,
  });
  return {
    version: "customer-export-1",
    optimization: Array.from({ length: 3 }, (_, index) => row("train", index, 1)),
    validation: Array.from({ length: 20 }, (_, index) => row("validation", index, 2)),
    audit: Array.from({ length: 50 }, (_, index) => row("audit", index, 3)),
  };
}
