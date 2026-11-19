import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  decideAcceptance,
  mulberry32,
  type GateItem,
  type GateParameters,
} from "../src/acceptance-gate.js";
import { compare } from "../src/improvement-evidence.js";
import type { AutonomyPolicy, Comparison } from "../src/improvement-contracts.js";
import {
  appendRound,
  emptySeedLog,
  replaySeed,
  type SeedDecisionLog,
} from "../benchmarks/public/decisions.js";

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
  assert.equal(compare(comparison, rows, fixed, false).passed, false);
  assert.equal(compare(comparison, rows, confidence, false).passed, true);
  assert.equal(compare(comparison, rows, fixed, true).passed, false);
  assert.equal(compare(comparison, rows, confidence, true).passed, true);
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
  assert.throws(
    () =>
      decideAcceptance({
        items,
        unpaired: { candidateSuccesses: 1, candidateTrials: 2, incumbentSuccesses: 0, incumbentTrials: 2 },
        parameters: rule,
      }),
    /not both/,
  );
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

test("a tampered rule or an incomplete log does not replay as matched", () => {
  const log = acceptedSeed(9);
  log.rounds[0]!.rule = { ...rule, seed: rule.seed + 1 };
  assert.match(replaySeed(log, rule).mismatches.join(" "), /rule/);
  log.rounds[0]!.rule = { ...rule };
  log.complete = false;
  assert.match(replaySeed(log, rule).mismatches.join(" "), /incomplete/);
});

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
