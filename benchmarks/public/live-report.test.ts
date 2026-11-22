import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { row } from "../hotpotqa/fixtures.js";
import { hotpotTask } from "../hotpotqa/task.js";
import { UNPAIRED_QUESTION_LIMIT } from "./analysis.js";
import { publishLiveReport } from "./cli.js";
import { PROPOSE_NAME } from "./instructions.js";
import { resolveLimits } from "./limits.js";
import {
  heldOutQuestionsPath,
  heldOutQuestionsTempPath,
  runLiveTask,
  writeHeldOutQuestions,
  type PublicLiveReport,
} from "./live.js";
import type { RateDraft } from "./loop.js";

const KEY = "sk-test-secret-key-value";
const SPLIT = { optimization: 2, validation: 5, audit: 10, production: 2 };

interface QuestionsFile {
  perSeed: {
    seed: number;
    baseline: { id: string; correct: boolean; failed: boolean }[];
    strongPrompt: { id: string; correct: boolean; failed: boolean }[];
    oneShot: { id: string; correct: boolean; failed: boolean }[];
    controllerServed: { id: string; correct: boolean; failed: boolean }[];
    controllerUngated: { id: string; correct: boolean; failed: boolean }[] | null;
  }[];
}

test("a normal live run keeps its headline and writes questions after each seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-report-normal-"));
  const reportPath = join(directory, "report.json");
  const seen: number[] = [];
  try {
    const report = await runScored({
      directory,
      reportPath,
      seeds: [1, 2],
      heldOut: 2,
      before: async () => {
        const saved = await readQuestions(directory, reportPath);
        if (!saved) return;
        seen.push(saved.perSeed.length);
        assert.ok(saved.perSeed[0]?.baseline.length);
      },
    });
    assert.ok(seen.includes(1));
    assert.ok(seen.every((count) => count === 1));
    assert.equal(report.stopped, null);
    assert.equal(report.passed, true);
    assert.equal(report.perSeed.length, 2);
    assert.equal(report.perSeed.every((row) => row.status === "complete"), true);
    assert.equal(report.analysisError, undefined);
    assert.equal(Object.hasOwn(report, "analysisError"), false);
    assert.equal(report.headline?.name, "controller-served-vs-baseline");
    assert.ok(report.comparisons && report.comparisons.length > 0);
    assert.ok(report.promptSensitivity);

    const saved = await readQuestions(directory, reportPath);
    if (!saved) throw new Error("questions file missing");
    assert.equal(saved.perSeed.length, 2);
    for (const row of report.perSeed) {
      const found: QuestionsFile["perSeed"][number] | undefined = saved.perSeed.find(
        (item) => item.seed === row.seed,
      );
      if (!found) throw new Error(`questions file missing seed ${row.seed}`);
      assert.deepEqual(found.baseline, row.baseline.items);
      assert.deepEqual(found.strongPrompt, row.strongPrompt.items);
      assert.deepEqual(found.oneShot, row.oneShot.items);
      assert.deepEqual(found.controllerServed, row.controllerServed.items);
      assert.deepEqual(found.controllerUngated, row.controllerUngated?.items ?? null);
    }

    const logs = capture();
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await publishLiveReport(reportPath, report, KEY);
      assert.equal(process.exitCode, undefined);
      assert.ok(logs.lines.some((line) => line.startsWith(`PASS ${reportPath}`)));
      assert.equal(logs.lines.some((line) => line.startsWith("Analysis failed:")), false);
      const written = JSON.parse(await readFile(reportPath, "utf8")) as PublicLiveReport;
      assert.equal(Object.hasOwn(written, "analysisError"), false);
      assert.equal(written.headline?.name, "controller-served-vs-baseline");
      assert.equal(written.perSeed[0]?.baseline.items.length, report.perSeed[0]?.baseline.items.length);
    } finally {
      logs.restore();
      process.exitCode = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed seed still writes its held-out questions before the next seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-report-seed-"));
  const reportPath = join(directory, "report.json");
  let sawFailedSeed = false;
  let thrown = false;
  try {
    const report = await runScored({
      directory,
      reportPath,
      seeds: [1, 2],
      heldOut: 2,
      before: async () => {
        const saved = await readQuestions(directory, reportPath);
        if (!saved) return;
        assert.equal(saved.perSeed.length, 1);
        assert.equal(saved.perSeed[0]?.seed, 1);
        assert.deepEqual(saved.perSeed[0]?.baseline, []);
        assert.equal(saved.perSeed[0]?.controllerUngated, null);
        sawFailedSeed = true;
      },
      fetch: async (_url, init) => {
        if (!thrown) {
          thrown = true;
          throw new Error("provider threw inside the seed");
        }
        return scriptedResponse(init);
      },
    });
    assert.equal(sawFailedSeed, true);
    assert.equal(report.stopped, null);
    assert.equal(report.analysisError, undefined);
    assert.equal(report.headline?.name, "controller-served-vs-baseline");
    assert.equal(report.perSeed[0]?.status, "failed");
    assert.equal(report.perSeed[1]?.status, "complete");
    const saved = await readQuestions(directory, reportPath);
    assert.ok(saved);
    assert.equal(saved.perSeed.length, 2);
    assert.deepEqual(saved.perSeed[0]?.baseline, []);
    assert.deepEqual(saved.perSeed[1]?.baseline, report.perSeed[1]?.baseline.items);
    assert.ok((saved.perSeed[1]?.baseline.length ?? 0) > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("too many unpaired questions still writes report.json with the raw items", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-report-unpaired-"));
  const reportPath = join(directory, "report.json");
  const heldOut = Math.floor(UNPAIRED_QUESTION_LIMIT / 2) + 1;
  let strong = false;
  const previous = process.exitCode;
  const logs = capture();
  process.exitCode = undefined;
  try {
    const report = await runScored({
      directory,
      reportPath,
      seeds: [1],
      heldOut,
      scoreMany: async (items) => {
        if (strong) {
          for (const item of items) {
            if (item.row.id.startsWith("held-")) item.row.id = `other-${item.row.id}`;
          }
        }
        return hotpotTask.scoreMany(items);
      },
      fetch: async (_url, init) => {
        const parsed = bodyOf(init);
        if (parsed.text?.format?.name === PROPOSE_NAME)
          return answerResponse(hotpotTask.baselinePrompt, "fragment");
        strong = parsed.instructions === hotpotTask.strongPrompt;
        return answerResponse("Paris");
      },
    });
    assert.equal(report.stopped, null);
    assert.equal(report.passed, false);
    assert.equal(report.perSeed.length, 1);
    assert.equal(report.perSeed[0]?.status, "complete");
    assert.equal(report.headline, null);
    assert.equal(report.comparisons, null);
    assert.equal(report.promptSensitivity, null);
    assert.match(
      report.analysisError ?? "",
      new RegExp(`Unpaired questions ${heldOut * 2} exceed ${UNPAIRED_QUESTION_LIMIT}`),
    );
    const baselineIds = report.perSeed[0]?.baseline.items.map((item) => item.id) ?? [];
    const strongIds = report.perSeed[0]?.strongPrompt.items.map((item) => item.id) ?? [];
    assert.equal(baselineIds.length, heldOut);
    assert.equal(strongIds.length, heldOut);
    assert.equal(baselineIds.some((id) => strongIds.includes(id)), false);

    const saved = await readQuestions(directory, reportPath);
    assert.ok(saved);
    assert.deepEqual(saved.perSeed[0]?.baseline, report.perSeed[0]?.baseline.items);
    assert.deepEqual(saved.perSeed[0]?.strongPrompt, report.perSeed[0]?.strongPrompt.items);

    await publishLiveReport(reportPath, report, KEY);
    assert.equal(process.exitCode, 1);
    assert.ok(logs.lines.some((line) => line.startsWith(`FAIL ${reportPath}`)));
    assert.ok(
      logs.lines.some(
        (line) => line.startsWith("Analysis failed: ") && line.includes(report.analysisError ?? ""),
      ),
    );
    assert.equal(logs.lines.some((line) => line.includes("controller-served-vs-baseline")), false);
    assert.equal(logs.lines.some((line) => line.includes(KEY)), false);
    const written = JSON.parse(await readFile(reportPath, "utf8")) as PublicLiveReport & {
      perSeed: PublicLiveReport["perSeed"];
    };
    assert.equal(written.headline, null);
    assert.equal(written.comparisons, null);
    assert.equal(written.promptSensitivity, null);
    assert.equal(written.analysisError, report.analysisError);
    assert.deepEqual(written.perSeed[0]?.baseline.items, report.perSeed[0]?.baseline.items);
    assert.deepEqual(written.perSeed[0]?.strongPrompt.items, report.perSeed[0]?.strongPrompt.items);
    assert.deepEqual(written.perSeed[0]?.oneShot.items, report.perSeed[0]?.oneShot.items);
    assert.deepEqual(written.perSeed[0]?.controllerServed.items, report.perSeed[0]?.controllerServed.items);
  } finally {
    logs.restore();
    process.exitCode = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the questions file is replaced by rename and a failed temp write leaves it whole", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-report-atomic-"));
  const reportPath = join(directory, "report.json");
  const target = heldOutQuestionsPath(reportPath);
  const temporary = heldOutQuestionsTempPath(reportPath);
  try {
    await writeHeldOutQuestions(reportPath, [seedRow(1, ["q-1"])]);
    const first = await readFile(target, "utf8");
    const parsed = JSON.parse(first) as QuestionsFile;
    assert.equal(parsed.perSeed.length, 1);
    assert.equal(parsed.perSeed[0]?.baseline[0]?.id, "q-1");
    assert.equal(existsSync(temporary), false);
    assert.equal((await readdir(directory)).includes(basename(temporary)), false);

    await mkdir(temporary);
    await assert.rejects(writeHeldOutQuestions(reportPath, [seedRow(1, ["q-1"]), seedRow(2, ["q-2"])]));
    assert.equal(await readFile(target, "utf8"), first);
    JSON.parse(first);

    await rm(temporary, { recursive: true, force: true });
    await writeHeldOutQuestions(reportPath, [seedRow(1, ["q-1"]), seedRow(2, ["q-2"])]);
    assert.equal(existsSync(temporary), false);
    const replaced = JSON.parse(await readFile(target, "utf8")) as QuestionsFile;
    assert.equal(replaced.perSeed.length, 2);
    assert.equal(replaced.perSeed[0]?.baseline[0]?.id, "q-1");
    assert.equal(replaced.perSeed[1]?.baseline[0]?.id, "q-2");
    assert.equal(replaced.perSeed[1]?.controllerUngated?.[0]?.id, "q-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readQuestions(directory: string, reportPath: string): Promise<QuestionsFile | null> {
  const target = heldOutQuestionsPath(reportPath);
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as QuestionsFile;
  const names = await readdir(directory);
  assert.equal(names.includes(basename(heldOutQuestionsTempPath(reportPath))), false);
  return parsed;
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const push = (...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  };
  console.log = push;
  console.error = push;
  return {
    lines,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

async function runScored(input: {
  directory: string;
  reportPath: string;
  seeds: number[];
  heldOut: number;
  before?: () => Promise<void>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  scoreMany?: typeof hotpotTask.scoreMany;
}): Promise<PublicLiveReport> {
  const task = {
    ...hotpotTask,
    fullSizes: { ...SPLIT, heldOut: input.heldOut },
    ...(input.scoreMany ? { scoreMany: input.scoreMany } : {}),
  };
  return runLiveTask(
    task,
    {
      seeds: input.seeds,
      smoke: true,
      deployment: "loopiter-gpt-5-6",
      apiVersion: "v1",
      endpoint: "https://example.openai.azure.com/",
      apiKey: KEY,
      prices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
      totalCapUsd: 50,
      warnUsd: 40,
      invocationCapUsd: 50,
      stopAtWarn: false,
      ledgerPath: join(input.directory, "ledger.json"),
      limits: resolveLimits({}, hotpotTask),
      minimumImprovement: 0,
      maxTokensPerMinute: 0,
      maxRetryWaitMs: 1_000,
      max429Retries: 0,
      requestTimeoutMs: 5_000,
      maxTotalWaitMs: 5_000,
      stallTimeoutMs: 600_000,
      reportPath: input.reportPath,
      fetch: async (url, init) => {
        if (input.before) await input.before();
        if (input.fetch) return input.fetch(String(url), init);
        return scriptedResponse(init);
      },
    },
    {
      pool: Array.from({ length: 19 }, (_, index) => row(`pool-${index}`, "Paris", false)),
      heldOut: Array.from({ length: input.heldOut }, (_, index) => row(`held-${index}`, "Paris", false)),
    },
  );
}

function scriptedResponse(init?: RequestInit): Response {
  const parsed = bodyOf(init);
  if (parsed.text?.format?.name === PROPOSE_NAME) return answerResponse(hotpotTask.baselinePrompt, "fragment");
  return answerResponse("Paris");
}

function bodyOf(init?: RequestInit): {
  instructions?: string;
  text?: { format?: { name?: string } };
} {
  const raw = typeof init?.body === "string" ? init.body : "";
  return raw ? (JSON.parse(raw) as { instructions?: string; text?: { format?: { name?: string } } }) : {};
}

function answerResponse(text: string, field: "text" | "fragment" = "text"): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ [field]: text }) }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function seedRow(seed: number, ids: string[]): PublicLiveReport["perSeed"][number] {
  const draft = items(ids);
  return {
    seed,
    baseline: draft,
    strongPrompt: draft,
    oneShot: draft,
    controllerServed: draft,
    controllerUngated: draft,
    controllerState: "completed",
    controllerReason: "completed",
    controllerDetail: null,
    proposeCalls: 0,
    proposeRefusals: 0,
    status: "complete",
    failure: null,
  };
}

function items(ids: string[]): RateDraft {
  return {
    successes: ids.length,
    trials: ids.length,
    rate: ids.length === 0 ? 0 : 1,
    loose: null,
    f1: null,
    instructionStrict: null,
    instructionLoose: null,
    items: ids.map((id) => ({ id, correct: true, failed: false })),
  };
}
