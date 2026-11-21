import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  decideAcceptance,
  minimumDecisiveFloor,
  mulberry32,
  type GateItem,
  type GateParameters,
} from "../src/acceptance-gate.js";
import { compare } from "../src/improvement-evidence.js";
import {
  explainDecisionText,
  formatExplanation,
} from "../src/decision-explain.js";
import type { AutonomyPolicy, Comparison } from "../src/improvement-contracts.js";
import {
  appendRound,
  emptySeedLog,
  readDecisionLog,
  replaySeed,
  writeDecisionLog,
  type SeedDecisionLog,
} from "../benchmarks/public/decisions.js";
import { candidateIdFor } from "../benchmarks/public/loop.js";

const rule: GateParameters = {
  minimumEffect: 0,
  confidence: 0.9,
  samples: 500,
  seed: 17,
  minimumItems: 0,
};

function pairs(rows: readonly [number, number][]): GateItem[] {
  return rows.map(([incumbent, candidate], index) => ({
    id: `item-${index}`,
    incumbent,
    candidate,
  }));
}

function repeated(count: number, row: [number, number]): [number, number][] {
  return Array.from({ length: count }, () => row);
}

test("paired bootstrap accepts a clear gain and rejects a tie, noise, or a loss", () => {
  const better = decideAcceptance({
    items: pairs(repeated(40, [0, 1])),
    parameters: rule,
  });
  assert.equal(better.accept, true);
  assert.equal(better.reason, "accepted");
  assert.equal(better.method, "paired-bootstrap");
  assert.ok((better.lower ?? 0) > 0);

  const tied = decideAcceptance({
    items: pairs(repeated(40, [1, 1])),
    parameters: rule,
  });
  assert.equal(tied.accept, false);
  assert.equal(tied.reason, "below_minimum_effect");
  assert.equal(tied.lower, 0);

  const worse = decideAcceptance({
    items: pairs(repeated(40, [1, 0])),
    parameters: rule,
  });
  assert.equal(worse.accept, false);
  assert.ok((worse.lower ?? 0) < 0);

  const noisy = decideAcceptance({
    items: pairs([...repeated(21, [0, 1]), ...repeated(19, [1, 0])]),
    parameters: rule,
  });
  assert.equal(noisy.accept, false);
  assert.equal(noisy.reason, "below_minimum_effect");
});

test("the paired bootstrap is deterministic for a fixed seed", () => {
  const items = pairs([...repeated(21, [0, 1]), ...repeated(19, [1, 0])]);
  const first = decideAcceptance({ items, parameters: rule });
  const second = decideAcceptance({ items, parameters: rule });
  assert.deepEqual(first, second);
  assert.equal(mulberry32(17)(), mulberry32(17)());
  assert.notEqual(mulberry32(17)(), mulberry32(99)());
});

test("Wilson-Newcombe fallback decides when pairing is missing", () => {
  const clear = decideAcceptance({
    unpaired: {
      candidateSuccesses: 90,
      candidateTrials: 100,
      incumbentSuccesses: 40,
      incumbentTrials: 100,
    },
    parameters: rule,
  });
  assert.equal(clear.method, "newcombe-wilson");
  assert.equal(clear.accept, true);
  assert.ok((clear.lower ?? 0) > 0);

  const tied = decideAcceptance({
    unpaired: {
      candidateSuccesses: 50,
      candidateTrials: 100,
      incumbentSuccesses: 50,
      incumbentTrials: 100,
    },
    parameters: rule,
  });
  assert.equal(tied.accept, false);

  const noisy = decideAcceptance({
    unpaired: {
      candidateSuccesses: 52,
      candidateTrials: 100,
      incumbentSuccesses: 48,
      incumbentTrials: 100,
    },
    parameters: rule,
  });
  assert.equal(noisy.accept, false);
  assert.ok((noisy.lower ?? 0) < 0);
});

test("minimumItems blocks a gain that is otherwise clear", () => {
  const decision = decideAcceptance({
    items: pairs(repeated(4, [0, 1])),
    parameters: { ...rule, minimumItems: 10 },
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, "minimum_items");
});

test("one-shot is accepted when it is better and ignored when it is worse", () => {
  const better = emptySeedLog(1, "baseline");
  appendRound(better, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "validation",
    items: pairs(repeated(24, [0, 1])),
    rule,
  });
  appendRound(better, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "audit",
    items: pairs(repeated(24, [0, 1])),
    rule,
  });
  assert.equal(better.served.id, "one-shot");

  const worse = emptySeedLog(2, "baseline");
  appendRound(worse, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "validation",
    items: pairs(repeated(24, [1, 0])),
    rule,
  });
  assert.equal(worse.served.id, "baseline");
  assert.equal(replaySeed(better, rule).matched, true);
  assert.equal(replaySeed(worse, rule).matched, true);
});

test("a later accepted round with a smaller effect does not replace the earlier one", () => {
  const log = emptySeedLog(8, "baseline");
  const strong = pairs(repeated(20, [0, 1]));
  const weak = pairs([...repeated(4, [0, 1]), ...repeated(16, [1, 1])]);
  appendRound(log, { candidateId: "early", promptHash: "early", split: "validation", items: strong, rule });
  appendRound(log, { candidateId: "early", promptHash: "early", split: "audit", items: strong, rule });
  appendRound(log, { candidateId: "later", promptHash: "later", split: "validation", items: weak, rule });
  appendRound(log, { candidateId: "later", promptHash: "later", split: "audit", items: weak, rule });
  assert.equal(log.served.id, "early");
  assert.ok(log.rounds[1]!.decision.effect > log.rounds[3]!.decision.effect);
  assert.equal(replaySeed(log, rule).matched, true);
});

test("each comparison keeps the id of the candidate that was scored", () => {
  const known = [
    { id: "first", promptHash: "aaa" },
    { id: "second", promptHash: "bbb" },
  ];
  assert.equal(candidateIdFor("bbb", known), "second");
  assert.notEqual(candidateIdFor("bbb", known), known[0]!.id);
});

test("a later rejected round does not replace the accepted incumbent", () => {
  const log = emptySeedLog(3, "baseline");
  appendRound(log, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "validation",
    items: pairs(repeated(24, [0, 1])),
    rule,
  });
  appendRound(log, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "audit",
    items: pairs(repeated(24, [0, 1])),
    rule,
  });
  appendRound(log, {
    candidateId: "controller",
    promptHash: "later",
    split: "validation",
    items: pairs(repeated(24, [1, 0])),
    rule,
  });
  assert.equal(log.served.id, "one-shot");
  assert.equal(log.rounds[2]?.incumbentId, "one-shot");
  assert.equal(log.rounds[2]?.decision.accept, false);
  const replay = replaySeed(log, rule);
  assert.equal(replay.matched, true);
  assert.equal(replay.served.id, "one-shot");
  log.rounds[0]!.decision = { ...log.rounds[0]!.decision, accept: false, reason: "below_minimum_effect" };
  assert.equal(replaySeed(log, rule).matched, false);
});

test("served id is the baseline or a candidate that passed both splits", () => {
  const accepted = acceptedSeed(1);
  assert.equal(servedId(accepted), "one-shot");
  assert.equal(replaySeed(accepted, rule).matched, true);
  const unchanged = unchangedSeed(2);
  assert.equal(servedId(unchanged), "baseline");
  const auditFail = emptySeedLog(3, "baseline");
  appendRound(auditFail, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "validation",
    items: pairs(repeated(8, [0, 1])),
    rule,
  });
  appendRound(auditFail, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "audit",
    items: pairs(repeated(8, [1, 0])),
    rule,
  });
  assert.equal(servedId(auditFail), "baseline");
  const rolled = acceptedSeed(4);
  rolled.observation = "rolled_back";
  rolled.served = { ...rolled.baseline };
  assert.equal(settleImported(rolled), "baseline");
  assert.equal(replaySeed(rolled, rule).matched, true);
});

test("confidence acceptance keeps a small paired gain the fixed margin rejects", () => {
  const cases = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `up-${index}`, baseline: 0, candidate: 1 })),
    ...Array.from({ length: 192 }, (_, index) => ({ id: `tie-${index}`, baseline: 0, candidate: 0 })),
  ];
  const comparison: Comparison = {
    cases,
    metrics: { accuracy: 8 / 200 },
    estimatedServingCost: 0,
  };
  const rows = cases.map((row) => ({
    id: row.id,
    episodeId: row.id,
    entityId: row.id,
    occurredAt: "2026-03-15T12:00:00.000Z",
    observedAt: "2026-03-15T13:00:00.000Z",
    source: "verified-export",
    input: null,
    label: null,
  }));
  const fixed = policy();
  const confidence = policy({ acceptance: "confidence", minimumEffect: 0, confidence: 0.9, bootstrapSamples: 400, bootstrapSeed: 17, minimumItems: 0 });
  const fixedValidation = compare(comparison, rows, fixed, false);
  const confidenceValidation = compare(comparison, rows, confidence, false);
  assert.equal(fixedValidation.passed, false);
  assert.equal(fixedValidation.outcome, "rejected");
  assert.equal(fixedValidation.decisive, null);
  assert.equal(fixedValidation.required, null);
  assert.equal(confidenceValidation.passed, true);
  assert.equal(confidenceValidation.outcome, "accepted");
  assert.equal(confidenceValidation.decisive, 8);
  assert.equal(confidenceValidation.required, minimumDecisiveFloor(0.9));
  assert.equal(compare(comparison, rows, fixed, true).passed, false);
  assert.equal(compare(comparison, rows, confidence, true).passed, true);
});

test("fewer decisive items than the floor are insufficient, and one more can accept", () => {
  assert.equal(minimumDecisiveFloor(0.9), 5);
  assert.equal(minimumDecisiveFloor(0.95), 6);
  const strict = { ...rule, minimumDecisive: 5 };
  const short = decideAcceptance({
    items: pairs(repeated(4, [0, 1])),
    parameters: strict,
  });
  assert.equal(short.accept, false);
  assert.equal(short.outcome, "insufficient");
  assert.equal(short.reason, "insufficient_decisive");
  assert.equal(short.decisive, 4);
  assert.equal(short.required, 5);
  assert.equal(short.lower, null);
  assert.equal(short.upper, null);
  assert.equal(short.effect, 1);
  const ties = decideAcceptance({
    items: pairs(repeated(12, [1, 1])),
    parameters: strict,
  });
  assert.equal(ties.outcome, "insufficient");
  assert.equal(ties.decisive, 0);
  assert.equal(ties.required, 5);
  const enough = decideAcceptance({
    items: pairs(repeated(5, [0, 1])),
    parameters: strict,
  });
  assert.equal(enough.outcome, "accepted");
  assert.equal(enough.decisive, 5);
  assert.equal(enough.required, 5);
  assert.ok((enough.lower ?? 0) > 0);
  const unguarded = decideAcceptance({
    items: pairs(repeated(4, [0, 1])),
    parameters: rule,
  });
  assert.equal(unguarded.outcome, "accepted");
  assert.equal(unguarded.required, null);
  assert.equal(unguarded.decisive, 4);
});

test("the python gate matches a node decision", () => {
  const items = pairs([...repeated(21, [0, 1]), ...repeated(19, [1, 0])]);
  const node = decideAcceptance({ items, parameters: rule });
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const script = `
import json
from loopiter.acceptance_gate import decide_acceptance
rule = {"minimum_effect": 0, "confidence": 0.9, "samples": 500, "seed": 17, "minimum_items": 0}
pairs = ${JSON.stringify(items.map((item) => [item.incumbent, item.candidate]))}
items = [{"id": f"item-{i}", "incumbent": a, "candidate": b} for i, (a, b) in enumerate(pairs)]
flipped = list(reversed(items))
first = decide_acceptance(items, parameters=rule)
second = decide_acceptance(flipped, parameters=rule)
print(json.dumps({"accept": first["accept"], "reason": first["reason"], "lower": first["lower"], "same": first == second}))
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, "python/src") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    accept: boolean;
    reason: string;
    lower: number;
    same: boolean;
  };
  assert.equal(parsed.same, true);
  assert.equal(parsed.accept, node.accept);
  assert.equal(parsed.reason, node.reason);
  assert.equal(parsed.lower, node.lower);
});

test("paired decisions ignore input order and reject duplicate ids", () => {
  const items = pairs([...repeated(6, [0, 1]), ...repeated(4, [1, 0])]);
  const forward = decideAcceptance({ items, parameters: rule });
  const reversed = decideAcceptance({ items: [...items].reverse(), parameters: rule });
  const shuffled = decideAcceptance({
    items: [items[3]!, items[8]!, items[1]!, items[0]!, items[5]!, items[9]!, items[2]!, items[7]!, items[4]!, items[6]!],
    parameters: rule,
  });
  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffled, forward);
  assert.throws(() => decideAcceptance({ items: [items[0]!, items[0]!], parameters: rule }), /Duplicate/);
  const both = decideAcceptance({
    items,
    unpaired: { candidateSuccesses: 9, candidateTrials: 10, incumbentSuccesses: 1, incumbentTrials: 10 },
    parameters: rule,
  });
  assert.equal(both.method, "paired-bootstrap");
  assert.deepEqual(both, forward);
});

test("small samples, an empty sample, and minimize direction stay deterministic", () => {
  const one = decideAcceptance({ items: pairs([[0, 1]]), parameters: rule });
  assert.equal(one.itemCount, 1);
  const empty = decideAcceptance({ parameters: rule });
  assert.equal(empty.reason, "empty_sample");
  const ties = decideAcceptance({ items: pairs(repeated(5, [1, 1])), parameters: rule });
  assert.equal(ties.accept, false);
  const minimize = decideAcceptance({
    items: pairs(repeated(12, [1, 0])),
    direction: "minimize",
    parameters: rule,
  });
  assert.equal(minimize.accept, true);
  assert.throws(() => decideAcceptance({ items: pairs(repeated(4, [0, 1])), parameters: { ...rule, samples: 100_001 } }), /100/);
});

test("replay rejects a log whose rule is outside the documented bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gate-log-"));
  try {
    const log = acceptedSeed(11);
    log.complete = true;
    log.rounds[0]!.rule = { ...rule, confidence: 2, samples: 100 };
    writeDecisionLog(join(directory, "bad.json"), [log]);
    assert.throws(() => readDecisionLog(join(directory, "bad.json")), /bounds/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tampered rule or an incomplete log does not replay as matched", () => {
  const log = acceptedSeed(9);
  log.rounds[0]!.rule = { ...rule, seed: rule.seed + 1 };
  assert.match(replaySeed(log, rule).mismatches.join(" "), /rule/);
  log.rounds[0]!.rule = { ...rule };
  log.complete = false;
  assert.match(replaySeed(log, rule).mismatches.join(" "), /incomplete/);
});

test("an insufficient validation is not served, and a missing audit is null rather than zero", async () => {
  const strict = { ...rule, minimumDecisive: 5 };
  const log = emptySeedLog(21, "baseline");
  appendRound(log, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "validation",
    items: pairs(repeated(4, [0, 1])),
    rule: strict,
  });
  assert.equal(log.served.id, "baseline");
  assert.equal(log.rounds[0]?.decision.outcome, "insufficient");
  assert.equal(replaySeed(log, strict).matched, true);
  const directory = await mkdtemp(join(tmpdir(), "gate-explain-"));
  const path = join(directory, "decisions.json");
  try {
    writeDecisionLog(path, [log]);
    const explained = explainDecisionText(readFileSync(path, "utf8"));
    const candidate = explained.seeds[0]?.candidates[0];
    assert.equal(candidate?.validation?.outcome, "insufficient");
    assert.equal(candidate?.validation?.decisive, 4);
    assert.equal(candidate?.validation?.required, 5);
    assert.equal(candidate?.validation?.lower, null);
    assert.equal(candidate?.audit, null);
    const text = formatExplanation(explained);
    assert.match(text, /"one-shot" validation round 0 insufficient/);
    assert.match(text, /decisive 4 required 5/);
    assert.match(text, /"one-shot" audit null/);
    assert.equal(text.includes("audit round"), false);
    const fresh = decideAcceptance({ items: pairs(repeated(4, [0, 1])), parameters: rule });
    const legacyDecision = { ...fresh } as Record<string, unknown>;
    delete legacyDecision.outcome;
    delete legacyDecision.decisive;
    delete legacyDecision.required;
    const legacy = {
      schemaVersion: 1,
      kind: "acceptance-decisions",
      seeds: [
        {
          seed: 4,
          baseline: { id: "baseline", promptHash: "base" },
          served: { id: "baseline", promptHash: "base" },
          rounds: [
            {
              round: 0,
              candidateId: "legacy",
              promptHash: "old",
              incumbentId: "baseline",
              incumbentPromptHash: "base",
              split: "validation",
              items: pairs(repeated(4, [0, 1])),
              rule,
              decision: legacyDecision,
            },
          ],
        },
      ],
    };
    const legacyPath = join(directory, "legacy.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const read = readDecisionLog(legacyPath);
    assert.equal(replaySeed(read.seeds[0]!, rule).matched, true);
    const legacyText = formatExplanation(explainDecisionText(JSON.stringify(legacy)));
    assert.match(legacyText, /decisive null required null/);
    assert.equal(legacyText.includes("decisive 0"), false);
    assert.match(legacyText, /audit null/);
    const malformed = spawnSync(process.execPath, [cliPath(), "explain", join(directory, "missing.json")], {
      encoding: "utf8",
    });
    assert.notEqual(malformed.status, 0);
    const broken = join(directory, "broken.json");
    await writeFile(broken, "{");
    const bad = spawnSync(process.execPath, [cliPath(), "explain", broken], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not JSON/);
    const usage = spawnSync(process.execPath, [cliPath(), "explain"], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    const nodeJson = spawnSync(process.execPath, [cliPath(), "explain", path, "--json"], { encoding: "utf8" });
    assert.equal(nodeJson.status, 0, nodeJson.stderr);
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const pythonJson = spawnSync("python3", ["-m", "loopiter", "explain", path, "--json"], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: join(root, "python/src") },
      encoding: "utf8",
    });
    assert.equal(pythonJson.status, 0, pythonJson.stderr);
    assert.deepEqual(JSON.parse(pythonJson.stdout), JSON.parse(nodeJson.stdout));
    const pythonText = spawnSync("python3", ["-m", "loopiter", "explain", path], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: join(root, "python/src") },
      encoding: "utf8",
    });
    assert.equal(pythonText.status, 0, pythonText.stderr);
    assert.equal(pythonText.stdout, text);
    const crafted = {
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
              candidateId: "c\u009b2J\u202e\u00e9\nseed 1 c9 audit round 9 accepted",
              promptHash: "p",
              incumbentId: "baseline",
              incumbentPromptHash: "base",
              split: "validation",
              rule,
              decision: {
                accept: false,
                outcome: "rejected",
                reason: "below\u001b[2J",
                lower: -1,
                upper: 0,
                effect: -1,
                method: "paired-bootstrap",
                itemCount: 5,
                decisive: 5,
                required: 5,
              },
            },
          ],
        },
      ],
    };
    const craftedPath = join(directory, "crafted.json");
    await writeFile(craftedPath, `${JSON.stringify(crafted)}\n`);
    const craftedText = formatExplanation(explainDecisionText(JSON.stringify(crafted)));
    assert.equal(craftedText.trim().split("\n").length, 2);
    assert.equal(craftedText.includes("\u001b"), false);
    assert.equal(craftedText.includes("\u009b"), false);
    assert.equal(craftedText.includes("\u202e"), false);
    assert.equal(craftedText.includes("\u00e9"), false);
    assert.match(craftedText, /\\nseed 1 c9/);
    assert.match(craftedText, /\\u001b/);
    assert.match(craftedText, /\\u009b/);
    assert.match(craftedText, /\\u202e/);
    assert.match(craftedText, /\\u00e9/);
    const craftedPython = spawnSync("python3", ["-m", "loopiter", "explain", craftedPath], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: join(root, "python/src") },
      encoding: "utf8",
    });
    assert.equal(craftedPython.status, 0, craftedPython.stderr);
    assert.equal(craftedPython.stdout, craftedText);
    const craftedJson = spawnSync(process.execPath, [cliPath(), "explain", craftedPath, "--json"], {
      encoding: "utf8",
    });
    assert.equal(craftedJson.status, 0, craftedJson.stderr);
    const craftedParsed = JSON.parse(craftedJson.stdout) as {
      seeds: { candidates: { candidateId: string; validation: { reason: string } | null }[] }[];
    };
    assert.equal(
      craftedParsed.seeds[0]?.candidates[0]?.candidateId,
      "c\u009b2J\u202e\u00e9\nseed 1 c9 audit round 9 accepted",
    );
    assert.equal(craftedParsed.seeds[0]?.candidates[0]?.validation?.reason, "below\u001b[2J");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function cliPath(): string {
  return fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url));
}

function servedId(log: SeedDecisionLog): string {
  return replaySeed(log, rule).served.id;
}

function settleImported(log: SeedDecisionLog): string {
  return replaySeed(log, rule).served.id;
}

function acceptedSeed(seed: number): SeedDecisionLog {
  const log = emptySeedLog(seed, "baseline");
  const gain = pairs(repeated(24, [0, 1]));
  appendRound(log, { candidateId: "one-shot", promptHash: "one", split: "validation", items: gain, rule });
  appendRound(log, { candidateId: "one-shot", promptHash: "one", split: "audit", items: gain, rule });
  log.heldOut = {
    baseline: { successes: 40, trials: 100 },
    "one-shot": { successes: 70, trials: 100 },
  };
  return log;
}

function rejectedLaterSeed(seed: number): SeedDecisionLog {
  const log = acceptedSeed(seed);
  appendRound(log, {
    candidateId: "controller",
    promptHash: "later",
    split: "validation",
    items: pairs(repeated(24, [1, 0])),
    rule,
  });
  log.heldOut = {
    ...log.heldOut,
    controller: { successes: 90, trials: 100 },
  };
  return log;
}

function unchangedSeed(seed: number): SeedDecisionLog {
  const log = emptySeedLog(seed, "baseline");
  appendRound(log, {
    candidateId: "one-shot",
    promptHash: "one",
    split: "validation",
    items: pairs(repeated(24, [1, 1])),
    rule,
  });
  log.heldOut = {
    baseline: { successes: 55, trials: 100 },
    "one-shot": { successes: 10, trials: 100 },
  };
  return log;
}

function policy(objective: Partial<AutonomyPolicy["objective"]> = {}): AutonomyPolicy {
  return {
    objective: {
      metric: "accuracy",
      direction: "maximize",
      minimumImprovement: 0.05,
      range: [0, 1],
      alpha: 0.05,
      ...objective,
    },
    guardrails: [{ metric: "accuracy", comparator: "gte", value: 0 }],
    minimumValidationUnits: 1,
    minimumAuditUnits: 1,
  } as AutonomyPolicy;
}
