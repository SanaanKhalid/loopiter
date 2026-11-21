import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decideRetention,
  nextBestEver,
  notMeasuredRetention,
  rememberRetentionDecision,
  type BestEverRecord,
  type GateParameters,
} from "../src/acceptance-gate.js";
import {
  explainDecisionText,
  formatExplanation,
  formatRetentionStatus,
  parseRetentionLedger,
} from "../src/decision-explain.js";

const rule: GateParameters = {
  minimumEffect: 0,
  confidence: 0.9,
  samples: 200,
  seed: 17,
  minimumItems: 0,
  minimumDecisive: 5,
};

function items(score: number, count = 8, prefix = "item"): { id: string; score: number }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, score }));
}

function best(score: number, count = 8): BestEverRecord {
  return { id: "best", score, items: items(score, count) };
}

test("retention passes, fails, and stays unmeasured", () => {
  const regressed = decideRetention({
    enabled: true,
    candidateItems: items(0.2),
    bestEver: best(1),
    margin: 0.05,
    parameters: rule,
  });
  assert.equal(regressed.outcome, "retention_regression");
  assert.equal(regressed.reason, "retention_regression");
  assert.equal(regressed.bestEverId, "best");
  assert.equal(regressed.items, 8);
  assert.ok((regressed.lower ?? 0) < -0.05);

  const within = decideRetention({
    enabled: true,
    candidateItems: items(0.9),
    bestEver: best(1),
    margin: 0.2,
    parameters: rule,
  });
  assert.equal(within.outcome, "pass");
  assert.equal(within.bestEverId, "best");
  assert.ok((within.lower ?? -1) >= -0.2);

  const off = decideRetention({
    enabled: false,
    candidateItems: items(0),
    bestEver: best(1),
    margin: 0,
    parameters: rule,
  });
  assert.deepEqual(off, notMeasuredRetention());
  assert.equal(off.items, null);
  assert.equal(off.lower, null);
  assert.equal(off.margin, null);

  const fresh = decideRetention({
    enabled: true,
    candidateItems: items(1),
    bestEver: null,
    margin: 0.05,
    parameters: rule,
  });
  assert.deepEqual(fresh, notMeasuredRetention());

  const disjoint = decideRetention({
    enabled: true,
    candidateItems: items(0, 8, "other"),
    bestEver: best(1),
    margin: 0.05,
    parameters: rule,
  });
  assert.equal(disjoint.outcome, "not_measured");
  assert.equal(disjoint.items, null);
  assert.equal(JSON.stringify(disjoint).includes(":0"), false);

  const short = decideRetention({
    enabled: true,
    candidateItems: items(0.2, 2),
    bestEver: best(1, 2),
    margin: 0.05,
    parameters: rule,
  });
  assert.equal(short.outcome, "insufficient");
  assert.equal(short.reason, "insufficient_decisive");
  assert.equal(short.lower, null);
  assert.equal(short.items, 2);
  assert.equal(short.margin, 0.05);

  const shuffled = decideRetention({
    enabled: true,
    candidateItems: [...items(0.2)].reverse(),
    bestEver: { ...best(1), items: [...items(1)].reverse() },
    margin: 0.05,
    parameters: rule,
  });
  assert.equal(shuffled.lower, regressed.lower);
  assert.equal(shuffled.outcome, regressed.outcome);
});

test("best-ever moves only to a strictly better control score", () => {
  const current = nextBestEver({
    current: null,
    candidateId: "first",
    items: items(0.5),
  });
  assert.equal(current.id, "first");
  assert.equal(current.score, 0.5);
  const kept = nextBestEver({
    current,
    candidateId: "lower",
    items: items(0.25),
  });
  assert.equal(kept.id, "first");
  const tied = nextBestEver({
    current,
    candidateId: "tied",
    items: items(0.5),
  });
  assert.equal(tied.id, "first");
  const raised = nextBestEver({
    current,
    candidateId: "higher",
    items: items(0.75),
  });
  assert.equal(raised.id, "higher");
  assert.equal(raised.score, 0.75);
  const minimized = nextBestEver({
    current: { id: "high", score: 0.4, items: items(0.4) },
    candidateId: "low",
    items: items(0.1),
    direction: "minimize",
  });
  assert.equal(minimized.id, "low");
  const rolled = rememberRetentionDecision(
    { bestEver: raised, decisions: [] },
    { ...notMeasuredRetention(), candidateId: "rolled" },
  );
  assert.equal(rolled.bestEver?.id, "higher");
  assert.equal(rolled.decisions.at(-1)?.candidateId, "rolled");
});

test("explain and retention status match across both SDKs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retention-status-"));
  try {
    const craftedId = "c\u007f\u009b2J\u202e\u00e9\u{1F600}\nbest";
    const ledger = {
      schemaVersion: 1,
      kind: "retention-ledger",
      bestEver: {
        id: craftedId,
        score: 0.8,
        items: [{ id: craftedId, score: 0.8 }],
      },
      decisions: [
        {
          candidateId: "next",
          outcome: "retention_regression",
          reason: "retention_regression",
          bestEverId: craftedId,
          lower: -0.25,
          margin: 0.05,
          items: 8,
        },
        {
          candidateId: "quiet",
          outcome: "not_measured",
          reason: "not_measured",
          bestEverId: null,
          lower: null,
          margin: null,
          items: null,
        },
      ],
    };
    const path = join(directory, "ledger.json");
    await writeFile(path, `${JSON.stringify(ledger)}\n`);
    const text = formatRetentionStatus(parseRetentionLedger(JSON.stringify(ledger)));
    assert.equal(text.includes("\u001b"), false);
    assert.equal(text.includes("\u007f"), false);
    assert.equal(text.includes("\u009b"), false);
    assert.equal(text.includes("\u202e"), false);
    assert.equal([...text].every((character) => {
      const code = character.charCodeAt(0);
      return code === 0x0a || (code >= 0x20 && code <= 0x7e);
    }), true);
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const env = { ...process.env, PYTHONPATH: join(root, "python/src") };
    const nodeText = spawnSync(process.execPath, [cliPath(), "retention", "status", path], {
      encoding: "utf8",
    });
    const pythonText = spawnSync(
      "python3",
      ["-m", "loopiter", "retention", "status", path],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(nodeText.status, 0, nodeText.stderr);
    assert.equal(pythonText.status, 0, pythonText.stderr);
    assert.equal(pythonText.stdout, nodeText.stdout);
    assert.equal(nodeText.stdout, text);
    const nodeJson = spawnSync(
      process.execPath,
      [cliPath(), "retention", "status", path, "--json"],
      { encoding: "utf8" },
    );
    const pythonJson = spawnSync(
      "python3",
      ["-m", "loopiter", "retention", "status", path, "--json"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(nodeJson.status, 0, nodeJson.stderr);
    assert.equal(pythonJson.stdout, nodeJson.stdout);
    assert.equal([...nodeJson.stdout].every((character) => character.charCodeAt(0) <= 127), true);
    const parsed = JSON.parse(nodeJson.stdout) as { bestEver: { id: string } };
    assert.equal(parsed.bestEver.id, craftedId);
    const emptyNode = spawnSync(process.execPath, [cliPath(), "retention", "status"], {
      cwd: directory,
      encoding: "utf8",
    });
    const emptyPython = spawnSync("python3", ["-m", "loopiter", "retention", "status"], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    assert.equal(emptyNode.status, 0, emptyNode.stderr);
    assert.equal(emptyPython.stdout, emptyNode.stdout);
    assert.equal(emptyNode.stdout, "bestEver null score null items null\n");
    const log = {
      schemaVersion: 1,
      kind: "acceptance-decisions",
      seeds: [
        {
          seed: 1,
          baseline: { id: "baseline", promptHash: "base" },
          served: { id: "baseline", promptHash: "base" },
          rounds: [
            {
              round: 0,
              candidateId: "kept",
              promptHash: "p",
              incumbentId: "baseline",
              incumbentPromptHash: "base",
              split: "audit",
              rule,
              decision: {
                accept: true,
                outcome: "accepted",
                reason: "accepted",
                lower: 0.2,
                upper: 0.4,
                effect: 0.3,
                method: "paired-bootstrap",
                itemCount: 8,
                decisive: 8,
                required: 5,
                retention: ledger.decisions[0],
              },
            },
          ],
        },
      ],
    };
    const explained = formatExplanation(explainDecisionText(JSON.stringify(log)));
    assert.match(explained, /retention retention_regression/);
    assert.match(explained, /retentionLower -0.25/);
    assert.match(explained, /retentionItems 8/);
    const bare = formatExplanation(
      explainDecisionText(
        JSON.stringify({
          ...log,
          seeds: [
            {
              ...log.seeds[0],
              rounds: [{ ...log.seeds[0]!.rounds[0], decision: { ...log.seeds[0]!.rounds[0]!.decision, retention: undefined } }],
            },
          ],
        }),
      ),
    );
    assert.match(bare, /retention not_measured/);
    assert.match(bare, /retentionItems null/);
    assert.equal(bare.includes("retentionItems 0"), false);
    assert.throws(
      () =>
        explainDecisionText(
          JSON.stringify({
            ...log,
            seeds: [
              {
                ...log.seeds[0],
                rounds: [
                  {
                    ...log.seeds[0]!.rounds[0],
                    decision: {
                      ...log.seeds[0]!.rounds[0]!.decision,
                      retention: {
                        outcome: "not_measured",
                        reason: "not_measured",
                        bestEverId: null,
                        lower: null,
                        margin: 0,
                        items: null,
                      },
                    },
                  },
                ],
              },
            ],
          }),
        ),
      /unmeasured retention/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function cliPath(): string {
  return fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url));
}
