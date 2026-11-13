import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reservedModelTokens } from "../kb-qa/live.js";
import {
  configureVerifier,
  resetVerifier,
  scoreWithVerifiers,
  type VerifierItem,
} from "../ifbench/score.js";
import { ifbenchFixtures } from "../ifbench/fixtures.js";
import { ifbenchTask } from "../ifbench/task.js";
import { keepFullParagraphRows } from "../hotpotqa/cache.js";
import { hotpotFixtures, row } from "../hotpotqa/fixtures.js";
import { HOTPOT_PARAGRAPHS } from "../hotpotqa/pins.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { sizedReservations } from "./budget.js";
import { requestBody } from "./bodies.js";
import { FULL_SIZES, PROMPT_CAP, PRODUCT_MINIMUM_IMPROVEMENT } from "./constants.js";
import { PREDICT_NAME } from "./instructions.js";
import { promptPolicy } from "./policy.js";
import { repoRoot } from "./paths.js";
import type { BenchmarkTask, PublicExample } from "./task.js";

test.after(async () => {
  await resetVerifier();
});

test("a full autonomous plan fits the live token budget", () => {
  const prompt = "x".repeat(PROMPT_CAP);
  assert.equal(prompt.length, 8000);
  const ifbench = [...ifbenchFixtures().pool, ...ifbenchFixtures().heldOut];
  const longestIf = ifbench.reduce((best, row) =>
    row.prompt.length > best.prompt.length ? row : best,
  );
  const hotpot = [...hotpotFixtures().pool, ...hotpotFixtures().heldOut];
  const longestHot = hotpot.reduce((best, row) =>
    hotpotTask.predictPayload(row).length > hotpotTask.predictPayload(best).length ? row : best,
  );
  assert.equal(longestHot.paragraphs.length, HOTPOT_PARAGRAPHS);
  assertFits(ifbenchTask, prompt, longestIf, 1024, 2048, true);
  assertFits(hotpotTask, prompt, longestHot, 256, 2048, false);
});

test("IFBench strict and loose match the upstream parity fixture", async () => {
  await resetVerifier();
  const fixture = JSON.parse(
    await readFile(join(repoRoot(import.meta.url), "benchmarks/ifbench/fixtures/parity.json"), "utf8"),
  ) as {
    verifierSha: string;
    cases: {
      name: string;
      group: string;
      prompt: string;
      instructionIdList: string[];
      kwargs: Record<string, unknown>[];
      response: string;
      strict: boolean[];
      loose: boolean[];
      strictPrompt: boolean;
      loosePrompt: boolean;
    }[];
  };
  assert.equal(fixture.verifierSha, "cd189a9c2889526d8af901d2103fd3e1ffcea6df");
  const empty = fixture.cases.filter((item) => item.group === "empty");
  assert.ok(empty.length >= 1);
  const lineDrops = fixture.cases.filter(
    (item) => item.group === "line-drop" || item.group === "line-drop-asterisk",
  );
  assert.deepEqual(
    lineDrops.map((item) => item.name),
    [
      "remove-first-line",
      "remove-last-line",
      "remove-both-lines",
      "remove-first-line-asterisk",
      "remove-last-line-asterisk",
      "remove-both-lines-asterisk",
    ],
  );
  const scores = await scoreWithVerifiers(fixture.cases.map(toItem));
  assert.equal(scores.length, fixture.cases.length);
  for (const [index, item] of fixture.cases.entries()) {
    const score = scores[index];
    assert.ok(score, item.name);
    assert.equal(score.primary, item.strictPrompt ? 1 : 0, item.name);
    assert.equal(score.loose, item.loosePrompt ? 1 : 0, item.name);
    assert.deepEqual(
      score.instructions.map((mark) => mark.strict),
      item.strict,
      item.name,
    );
    assert.deepEqual(
      score.instructions.map((mark) => mark.loose),
      item.loose,
      item.name,
    );
  }
});

test("a late verifier line is not delivered to the next request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ifbench-bridge-"));
  const pidFile = join(directory, "pids.txt");
  const script = join(repoRoot(import.meta.url), "benchmarks/ifbench/fixtures/fake_verifier.py");
  process.env.FAKE_PID_FILE = pidFile;
  delete process.env.FAKE_CHUNK_LOG;
  try {
    const python = process.env.LOOPITER_BENCH_PYTHON ?? "python3";
    configureVerifier({
      timeoutMs: 200,
      chunkSize: 25,
      command: [python, script, "slow"],
    });
    await assert.rejects(scoreWithVerifiers([sample("late")]));
    configureVerifier({
      timeoutMs: 5_000,
      command: [python, script, "fast"],
    });
    const scores = await scoreWithVerifiers([sample("next")]);
    assert.equal(scores[0]?.primary, 1);
    const pids = (await readFile(pidFile, "utf8")).trim().split("\n");
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
  } finally {
    delete process.env.FAKE_PID_FILE;
    await resetVerifier();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a large verifier batch is written in chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ifbench-chunks-"));
  const log = join(directory, "chunks.txt");
  const script = join(repoRoot(import.meta.url), "benchmarks/ifbench/fixtures/fake_verifier.py");
  process.env.FAKE_CHUNK_LOG = log;
  delete process.env.FAKE_PID_FILE;
  try {
    configureVerifier({
      timeoutMs: 5_000,
      chunkSize: 10,
      command: [process.env.LOOPITER_BENCH_PYTHON ?? "python3", script, "fast"],
    });
    const scores = await scoreWithVerifiers(Array.from({ length: 25 }, (_, index) => sample(`row-${index}`)));
    assert.equal(scores.length, 25);
    assert.deepEqual(
      (await readFile(log, "utf8")).trim().split("\n"),
      ["10", "10", "5"],
    );
  } finally {
    delete process.env.FAKE_CHUNK_LOG;
    await resetVerifier();
    await rm(directory, { recursive: true, force: true });
  }
});

test("IFBench train ids disambiguate duplicate keys", () => {
  const payload = runFetchModule<{
    ids: string[];
    stats: { duplicateKeys: number; rowsRewritten: number };
    collision: string;
  }>(join(repoRoot(import.meta.url), "benchmarks/ifbench/fetch.py"), `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ifbench_fetch", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
records = [
    ("hard_coded_18", "alpha prompt"),
    ("unique_key", "only once"),
    ("hard_coded_18", "beta prompt"),
    ("hard_coded_5", "one"),
    ("hard_coded_5", "two"),
    ("hard_coded_5", "three"),
]
ids, stats = mod.assign_train_ids(records)
collision = None
try:
    mod.assign_train_ids([("same", "prompt"), ("same", "prompt")])
except SystemExit as error:
    collision = str(error)
print(json.dumps({"ids": ids, "stats": stats, "collision": collision}))
`);
  assert.equal(payload.stats.duplicateKeys, 2);
  assert.equal(payload.stats.rowsRewritten, 5);
  assert.equal(payload.ids[1], "unique_key");
  const alpha = createHash("sha256").update("alpha prompt").digest("hex").slice(0, 12);
  const beta = createHash("sha256").update("beta prompt").digest("hex").slice(0, 12);
  assert.equal(payload.ids[0], `hard_coded_18-${alpha}`);
  assert.equal(payload.ids[2], `hard_coded_18-${beta}`);
  assert.equal(new Set(payload.ids).size, payload.ids.length);
  assert.match(payload.collision, /IFBench train ids are not unique: same-/);
});

test("HotpotQA fetch reads the title/sentences struct", () => {
  const root = repoRoot(import.meta.url);
  const payload = runFetchModule<{
    full: number;
    firstTitle: string;
    firstText: string;
    short: number;
    legacy: number;
    pair: number;
  }>(join(root, "benchmarks/hotpotqa/fetch.py"), `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("hotpot_fetch", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
fixture = json.load(open(sys.argv[2], encoding="utf-8"))
full = mod.paragraphs_from_context(fixture["full"]["context"])
short = mod.paragraphs_from_context(fixture["short"]["context"])
titles = fixture["full"]["context"]["title"]
sentences = fixture["full"]["context"]["sentences"]
legacy = mod.paragraphs_from_context([
    {"title": title, "sentences": sentence_list}
    for title, sentence_list in zip(titles, sentences)
])
pair = mod.paragraphs_from_context((titles, sentences))
print(json.dumps({
    "full": len(full),
    "firstTitle": full[0]["title"],
    "firstText": full[0]["text"],
    "short": len(short),
    "legacy": len(legacy),
    "pair": len(pair),
}))
`, join(root, "benchmarks/hotpotqa/fixtures/context-struct.json"));
  assert.equal(payload.full, HOTPOT_PARAGRAPHS);
  assert.equal(payload.short, 4);
  assert.equal(payload.firstTitle, "Notes");
  assert.equal(payload.firstText, "The city in the notes is Paris. It sits on the Seine.");
  assert.equal(payload.legacy, HOTPOT_PARAGRAPHS);
  assert.equal(payload.pair, HOTPOT_PARAGRAPHS);
});

test("HotpotQA cache drops rows that are not 10 paragraphs", () => {
  const full = row("full", "Paris", false);
  const short = row("short", "Lima", false);
  short.paragraphs = short.paragraphs.slice(0, 4);
  const result = keepFullParagraphRows([full, short]);
  assert.equal(result.dropped, 1);
  assert.deepEqual(
    result.rows.map((item) => item.id),
    ["full"],
  );
  assert.equal(result.rows[0]?.paragraphs.length, HOTPOT_PARAGRAPHS);
});

function runFetchModule<T>(fetchPy: string, script: string, fixture?: string): T {
  const args = ["-c", script, fetchPy];
  if (fixture) args.push(fixture);
  const result = spawnSync(process.env.LOOPITER_BENCH_PYTHON ?? "python3", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as T;
}

function assertFits<T extends PublicExample>(
  task: BenchmarkTask<T>,
  prompt: string,
  row: T,
  predictMax: number,
  proposeMax: number,
  feedback: boolean,
): void {
  const proposeRows = Array.from({ length: FULL_SIZES.optimization }, () => row);
  const reservations = sizedReservations({
    task,
    prompt,
    predictRow: row,
    proposeRows,
    predictMaxOutputTokens: predictMax,
    proposeMaxOutputTokens: proposeMax,
  });
  const predictBody = requestBody({
    model: "gpt-5.4-mini",
    instructions: prompt,
    payload: task.predictPayload(row),
    name: PREDICT_NAME,
    schema: task.predictSchema(),
    maxOutputTokens: predictMax,
    reasoningEffort: null,
  });
  assert.equal(reservations.predict, reservedModelTokens(predictBody, predictMax));
  const batchSize = 1;
  const observeChunk = 2;
  const policy = promptPolicy({
    taskId: task.id,
    promptCap: PROMPT_CAP,
    minimumImprovement: PRODUCT_MINIMUM_IMPROVEMENT,
    sizes: FULL_SIZES,
    latencyMs: 120_000,
    predictReservation: reservations.predict,
    proposeReservation: reservations.propose,
    batchSize,
    observeChunk,
  });
  let dailyTokens = 0;
  let dailyRequests = 0;
  const charge = (callback: string, amounts: number[]) => {
    let tokens = 0;
    let requests = 0;
    for (const amount of amounts) {
      tokens += amount;
      requests += 1;
      if (
        tokens > policy.callbackReservation.tokens ||
        requests > policy.callbackReservation.modelRequests
      )
        throw new Error(`budget_exhausted in ${task.id} ${callback}`);
      dailyTokens += amount;
      dailyRequests += 1;
      if (dailyTokens > policy.daily.tokens || dailyRequests > policy.daily.modelRequests)
        throw new Error(`budget_exhausted in ${task.id} daily ${callback}`);
    }
  };
  if (feedback)
    for (let index = 0; index < FULL_SIZES.optimization; index += 1)
      charge(`feedback-${index}`, [reservations.predict]);
  charge("propose", [reservations.propose]);
  for (let index = 0; index < FULL_SIZES.validation; index += batchSize)
    charge(`validation-${index}`, Array.from({ length: Math.min(batchSize, FULL_SIZES.validation - index) * 2 }, () => reservations.predict));
  for (let index = 0; index < FULL_SIZES.audit; index += batchSize)
    charge(`audit-${index}`, Array.from({ length: Math.min(batchSize, FULL_SIZES.audit - index) * 2 }, () => reservations.predict));
  for (let index = 0; index < FULL_SIZES.production; index += observeChunk)
    charge(`production-${index}`, Array.from({ length: Math.min(observeChunk, FULL_SIZES.production - index) }, () => reservations.predict));
  for (let index = 0; index < FULL_SIZES.heldOut; index += 1) {
    charge(`held-out-served-${index}`, [reservations.predict]);
    charge(`held-out-ungated-${index}`, [reservations.predict]);
  }
}

function toItem(item: {
  prompt: string;
  response: string;
  instructionIdList: string[];
  kwargs: Record<string, unknown>[];
}): VerifierItem {
  return {
    prompt: item.prompt,
    response: item.response,
    instructionIdList: item.instructionIdList,
    kwargs: item.kwargs,
  };
}

function sample(prompt: string): VerifierItem {
  return {
    prompt,
    response: "quartz",
    instructionIdList: ["keywords:existence"],
    kwargs: [{ keywords: ["quartz"] }],
  };
}
