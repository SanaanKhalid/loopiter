import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  FeedbackLoop,
  InMemoryStore,
  ImprovementController,
  prepareDataset,
  compare,
  type AutonomyPolicy,
  type DatasetSnapshot,
  type ImprovementWorkflow,
  type DeploymentRequest,
} from "../src/index.js";
import { Registry } from "./helpers.js";
import { assignCohort, validateChange } from "../src/index.js";

const fixtures = JSON.parse(
  await readFile(
    new URL("../../python/tests/fixtures/autonomy.json", import.meta.url),
    "utf8",
  ),
);

test("manual apply respects an autonomous target lock; reviewed rollback can finish recovery", async () => {
  const x = setup();
  let result;
  for (let i = 0; i < 4; i++)
    result = await x.controller().tick("classification");
  const run = (await x.controller().getRun(result!.runId!))!;
  const c = await x.loop.createCandidate({
    target: x.workflow.policy.target,
    proposedChange: { score: 0.9 },
    evidence: {},
    risk: "low",
  });
  const evaluated = await x.loop.evaluateCandidate(
    c.id,
    { evaluator: "manual", version: "1", datasetHash: "manual-fixture" },
    () => ({ passed: true }),
  );
  await x.loop.approveCandidate(c.id, {
    actor: "test",
    evaluationId: evaluated.evaluations[0]!.id,
  });
  await assert.rejects(x.loop.deployCandidate(c.id, { adapter: x.registry }), {
    code: "target_busy",
  });
  await x.controller().pause("classification", "manual recovery");
  await x.loop.rollbackCandidate(run.data.selectedId!, { adapter: x.registry });
  const recovered = await x.controller().tick("classification");
  assert.equal(recovered.state, "rolled_back");
  assert.equal(recovered.reason, "reviewed_rollback_confirmed");
});

test("an unrelated passing evaluation cannot replace the autonomous audit", async () => {
  const x = setup();
  await x.controller().tick("classification");
  const selected = await x.controller().tick("classification");
  const run = (await x.controller().getRun(selected.runId!))!;
  await x.loop.evaluateCandidate(
    run.data.selectedId!,
    {
      evaluator: "external-review",
      version: "different",
      datasetHash: "not-the-audit",
    },
    () => ({ passed: true, metrics: { errors: 0 } }),
  );
  const result = await x.controller().tick("classification");
  assert.equal(result.reason, "audit_evaluation_conflict");
  assert.equal(result.state, "failed");
  assert.equal(x.registry.applications, 0);
  assert.equal(
    (await x.loop.getCandidate(run.data.selectedId!))!.approval,
    undefined,
  );
});

test("an evaluation changed just before approval cannot gain autonomous authorization", async () => {
  const x = setup();
  await x.controller().tick("classification");
  const result = await x.controller().tick("classification");
  const run = (await x.controller().getRun(result.runId!))!;
  const artifact = x.workflow.artifact;
  x.workflow.artifact = async (c) => {
    await x.loop.evaluateCandidate(
      run.data.selectedId!,
      {
        evaluator: "external-review",
        version: "different",
        datasetHash: "not-the-audit",
      },
      () => ({ passed: true }),
    );
    return artifact(c);
  };
  const blocked = await x.controller().tick("classification");
  assert.equal(blocked.reason, "audit_evaluation_conflict");
  assert.equal(x.registry.applications, 0);
});

export function dataset(): DatasetSnapshot {
  const row = (name: string, i: number, day: number) => ({
    id: `customer-${name}-${i}`,
    episodeId: `ticket-${name}-${i}`,
    entityId: `person-${name}-${i}`,
    input: { text: "A customer correction, not a bundled fixture ID" },
    label: "billing",
    source: "verified-human",
    occurredAt: `2026-01-0${day}T00:00:00.000Z`,
    observedAt: `2026-01-0${day}T01:00:00.000Z`,
  });
  return {
    version: "customer-export-1",
    optimization: Array.from({ length: 3 }, (_, i) => row("train", i, 1)),
    validation: Array.from({ length: 20 }, (_, i) => row("validation", i, 2)),
    audit: Array.from({ length: 50 }, (_, i) => row("audit", i, 3)),
  };
}
function setup(
  s: {
    name: string;
    scores: number[];
    errors: number;
    productionErrors?: number;
  } = { name: "accepted", scores: [0.95, 0.85], errors: 0 },
) {
  let now = new Date("2026-02-01T00:00:00.000Z");
  let proposals = 0,
    evaluations = 0;
  class TestRegistry extends Registry {
    override async apply(r: DeploymentRequest) {
      const result = await super.apply(r);
      if (s.name === "interrupted") throw Error("Injected lost receipt");
      return result;
    }
  }
  const registry = new TestRegistry(),
    loop = new FeedbackLoop({
      store: new InMemoryStore(),
      namespace: "test",
      clock: () => now,
    });
  const policy = structuredClone(fixtures.policy) as AutonomyPolicy,
    data = dataset();
  if (s.name === "insufficient") data.audit = [];
  const workflow: ImprovementWorkflow = {
    id: "classification",
    version: "1",
    optimizerVersion: "1",
    evaluatorVersion: "paired-v1",
    policy,
    artifact: async () => ({
      artifactVersion: registry.version,
      configurationHash: "model-v1",
    }),
    dataset: async () => data,
    propose: async (_input, context) => {
      proposals++;
      return context.meter(100, async () => ({
        value: s.scores.map((score) => ({ score })),
        tokens: 40,
      }));
    },
    evaluate: async (input) => {
      evaluations++;
      return {
        cases: input.examples.map((row) => ({
          id: row.id,
          baseline: 0,
          candidate: (input.change as { score: number }).score,
        })),
        metrics: { errors: s.errors },
        estimatedServingCost: 1,
      };
    },
    deployment: registry,
    observe: async (input) => ({
      artifactVersion: input.artifactVersion,
      configurationHash: "model-v1",
      startedAt: input.deployedAt,
      endedAt: now.toISOString(),
      complete: !["delayed", "missing"].includes(s.name),
      unitIds: Array.from({ length: 10 }, (_, i) => `production-${i}`),
      metrics: { errors: s.productionErrors ?? 0 },
    }),
  };
  const controller = () =>
    new ImprovementController(loop, {
      mode: "autonomous",
      selfImproving: true,
      workflows: [workflow],
    });
  return {
    loop,
    registry,
    workflow,
    data,
    controller,
    advance: (hours = 2) => {
      now = new Date(+now + hours * 3600000);
    },
    counts: () => ({ proposals, evaluations }),
  };
}
for (const scenario of fixtures.scenarios)
  test(`shared behavioral fixture: ${scenario.name}`, async () => {
    const x = setup(scenario);
    let result = await x.controller().tick("classification");
    for (
      let i = 0;
      i < 8 &&
      ![
        "completed",
        "no_improvement",
        "rolled_back",
        "waiting_for_evidence",
      ].includes(result.state);
      i++
    ) {
      if (result.state === "observing")
        x.advance(scenario.name === "missing" ? 25 : 2);
      result = await x.controller().tick("classification");
      if (
        scenario.name === "delayed" &&
        result.reason === "waiting_for_mature_outcomes"
      )
        break;
    }
    assert.equal(result.state, scenario.expected, JSON.stringify(result));
    if (scenario.name === "accepted") {
      const run = (await x.controller().getRun(result.runId!))!;
      assert.equal(
        (await x.loop.getCandidate(run.data.selectedId!))!.proposedChange &&
          (
            (await x.loop.getCandidate(run.data.selectedId!))!
              .proposedChange as { score: number }
          ).score,
        0.95,
      );
      assert.equal(
        x.registry.applications,
        1,
        "Weaker passing candidate must not replace winner",
      );
      const calls = x.counts();
      await x.controller().tick("classification");
      assert.deepEqual(x.counts(), calls);
      assert.deepEqual(result.budget, {
        modelRequests: 1,
        tokens: 40,
        deployments: 1,
      });
    }
    if (scenario.name === "interrupted")
      assert.equal(x.registry.applications, 1);
    if (scenario.name === "regression" || scenario.name === "missing")
      assert.equal(x.registry.version, null);
  });
test("flag, exact schema and required budgets fail closed", async () => {
  const x = setup();
  assert.equal(
    (
      await new ImprovementController(x.loop, {
        mode: "autonomous",
        workflows: [x.workflow],
      }).tick("classification")
    ).reason,
    "self_improvement_disabled",
  );
  assert.equal(x.counts().proposals, 0);
  assert.throws(
    () =>
      new ImprovementController(x.loop, {
        mode: "apply" as never,
        workflows: [x.workflow],
      }),
  );
  delete (x.workflow.policy.daily as Partial<AutonomyPolicy["daily"]>).tokens;
  assert.throws(() => x.controller());
});
test("same evidence does not repeat a failed validation across restarts", async () => {
  const x = setup({ name: "rejected", scores: [0], errors: 0 });
  await x.controller().tick("classification");
  await x.controller().tick("classification");
  const prior = x.counts();
  assert.equal(
    (await x.controller().tick("classification")).reason,
    "unchanged_evidence",
  );
  assert.deepEqual(x.counts(), prior);
});
test("baseline drift is blocked after independent evaluation", async () => {
  const x = setup();
  await x.controller().tick("classification");
  await x.controller().tick("classification");
  x.registry.version = "external";
  const result = await x.controller().tick("classification");
  assert.equal(result.reason, "stale_baseline");
  assert.equal(x.registry.applications, 0);
});
test("concurrent ticks dispatch one proposal", async () => {
  const x = setup();
  await Promise.all([
    x.controller().tick("classification"),
    x.controller().tick("classification"),
  ]);
  assert.equal(x.counts().proposals, 1);
});
test("unknown token usage retains reservation and failed calls are not replayed", async () => {
  const x = setup();
  x.workflow.propose = async (_, c) =>
    c.meter(100, async () => {
      throw Error("response lost");
    });
  const a = await x.controller().tick("classification");
  assert.equal(a.state, "failed");
  assert.equal(a.budget.tokens, 100);
  assert.equal(
    (await x.controller().tick("classification")).reason,
    "unchanged_evidence",
  );
});
test("contradictions quarantine and duplicate episodes do not inflate audit", () => {
  const x = setup();
  x.data.optimization.push({
    ...x.data.optimization[0]!,
    id: "conflicting",
    label: "other",
  });
  x.data.audit.push({ ...x.data.audit[0]!, id: "duplicate" });
  const prepared = prepareDataset(
    x.data,
    x.workflow.policy,
    "2026-02-01T00:00:00Z",
  );
  assert.equal(prepared.optimization.length, 2);
  assert.equal(prepared.audit.length, 50);
  assert.throws(() =>
    compare(
      { cases: [], metrics: { errors: 0 }, estimatedServingCost: 0 },
      prepared.audit,
      x.workflow.policy,
    ),
  );
});
test("untrusted, delayed and cross-partition outcomes cannot authorize deployment", () => {
  const x = setup();
  x.data.optimization[0]!.observedAt = "2026-02-01T00:00:00Z";
  x.data.optimization[1]!.source = "model-generated";
  assert.equal(
    prepareDataset(x.data, x.workflow.policy, "2026-02-01T00:00:00Z")
      .optimization.length,
    1,
  );
  x.data.audit[0]!.entityId = x.data.optimization[2]!.entityId;
  assert.throws(() =>
    prepareDataset(x.data, x.workflow.policy, "2026-02-01T00:00:00Z"),
  );
});
test("pause prevents deployment, but observation failure may still roll back", async () => {
  const x = setup({
    name: "regression",
    scores: [1],
    errors: 0,
    productionErrors: 1,
  });
  for (let i = 0; i < 4; i++) await x.controller().tick("classification");
  await x.controller().pause("classification", "operator pause");
  x.advance();
  assert.equal(
    (await x.controller().tick("classification")).state,
    "rolling_back",
  );
  assert.equal(
    (
      await new ImprovementController(x.loop, {
        workflows: [x.workflow],
        mode: "autonomous",
      }).tick("classification")
    ).state,
    "rolled_back",
  );
});
test("observation callback failure does not reset observation deadline", async () => {
  const x = setup();
  for (let i = 0; i < 4; i++) await x.controller().tick("classification");
  x.workflow.observe = async () => {
    throw Error("monitor unavailable");
  };
  const a = await x.controller().tick("classification");
  assert.equal(a.state, "observing");
  x.advance(25);
  assert.equal(
    (await x.controller().tick("classification")).state,
    "rolling_back",
  );
});
for (const outcome of ["promoted", "not_applied", "unknown"] as const)
  test(`canary uncertain promotion: ${outcome}`, async () => {
    const x = setup();
    x.workflow.policy.rollout.mode = "canary";
    let promotions = 0;
    x.workflow.rollout = {
      promote: async () => {
        promotions++;
        throw Error("Injected lost promotion response");
      },
      inspect: async () => outcome,
    };
    const observe = x.workflow.observe;
    x.workflow.observe = async (i, c) => ({
      ...(await observe(i, c)),
      controlVersion: i.baseline.artifactVersion,
      assignmentHash: "stable-cohort-v1",
      controlUnitIds: Array.from({ length: 10 }, (_, i) => `control-${i}`),
      improvementLowerBound: 0.5,
    });
    for (let i = 0; i < 4; i++) await x.controller().tick("classification");
    x.advance();
    assert.equal(
      (await x.controller().tick("classification")).state,
      "reconciliation_required",
    );
    const next = await x.controller().tick("classification");
    assert.equal(
      next.state,
      outcome === "promoted"
        ? "completed"
        : outcome === "not_applied"
          ? "rolling_back"
          : "reconciliation_required",
    );
    assert.equal(promotions, 1);
    if (outcome === "not_applied")
      assert.equal(
        (await x.controller().tick("classification")).state,
        "rolled_back",
      );
  });
test("out-of-band changes are never blindly overwritten by rollback", async () => {
  const x = setup({
    name: "regression",
    scores: [1],
    errors: 0,
    productionErrors: 1,
  });
  for (let i = 0; i < 4; i++) await x.controller().tick("classification");
  x.advance();
  await x.controller().tick("classification");
  x.registry.version = "external-change";
  const r = await x.controller().tick("classification");
  assert.equal(r.reason, "out_of_band_change");
  assert.equal(x.registry.version, "external-change");
  assert.equal(x.registry.applications, 1);
});
test("audit examples cannot authorize successive selection cycles", async () => {
  const x = setup();
  const experiment = () =>
    new ImprovementController(x.loop, {
      workflows: [x.workflow],
      mode: "experiment",
    });
  for (let i = 0; i < 3; i++) await experiment().tick("classification");
  x.data.version = "new-export";
  x.data.optimization = x.data.optimization.map((r) => ({
    ...r,
    id: `new-${r.id}`,
    episodeId: `new-${r.episodeId}`,
    entityId: `new-${r.entityId}`,
  }));
  await experiment().tick("classification");
  await experiment().tick("classification");
  assert.equal(
    (await experiment().tick("classification")).reason,
    "audit_consumed",
  );
});
test("lost lease results are ignored and ambiguous optimizer calls never replay", async () => {
  const x = setup();
  x.workflow.propose = async () => {
    x.advance(1);
    return [{ score: 1 }];
  };
  const r = await x.controller().tick("classification");
  assert.equal(r.candidateIds.length, 0);
  assert.equal(
    (await x.controller().tick("classification")).reason,
    "ambiguous_callback",
  );
});
test("daily budget races block calls before external work", async () => {
  const x = setup();
  x.workflow.policy.daily.modelRequests = 1;
  let dispatched = 0;
  x.workflow.propose = async (_, c) => {
    await Promise.all(
      [1, 2].map(() =>
        c.meter(100, async () => {
          dispatched++;
          return { value: [], tokens: null };
        }),
      ),
    );
    return [];
  };
  const result = await x.controller().tick("classification");
  assert.equal(result.reason, "budget_exhausted");
  assert.equal(dispatched, 1);
  assert.equal(result.budget.modelRequests, 1);
});
test("reported overage is charged and cannot authorize a candidate", async () => {
  const x = setup();
  x.workflow.propose = async (_, c) =>
    c.meter(100, async () => ({ value: [{ score: 1 }], tokens: 150 }));
  const result = await x.controller().tick("classification");
  assert.equal(result.reason, "budget_contract");
  assert.equal(result.budget.tokens, 150);
  assert.equal(result.candidateIds.length, 0);
});
test("later flag disablement prevents an in-flight proposal from advancing", async () => {
  const x = setup();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  x.workflow.propose = async () => {
    entered();
    await gate;
    return [{ score: 1 }];
  };
  const running = x.controller().tick("classification");
  await ready;
  await new ImprovementController(x.loop, {
    workflows: [x.workflow],
    mode: "autonomous",
    selfImproving: false,
  }).tick("classification");
  release();
  const result = await running;
  assert.equal(result.candidateIds.length, 0);
  assert.equal(result.reason, "policy_changed");
});

test("article-inspired repeated failure stop retains history and requires logged resume", async () => {
  const x = setup({ name: "rejected", scores: [0], errors: 0 });
  const histories: unknown[] = [];
  const propose = x.workflow.propose;
  x.workflow.propose = async (i, c) => {
    histories.push(i.previousOutcomes);
    assert.equal(c.configuration?.policyVersion, "simulation-v1");
    assert.ok(Object.isFrozen(c.configuration));
    return propose(i, c);
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    x.data.version = `export-${cycle}`;
    x.data.optimization = x.data.optimization.map((r) => ({
      ...r,
      id: `${cycle}-${r.id}`,
      episodeId: `${cycle}-${r.episodeId}`,
      entityId: `${cycle}-${r.entityId}`,
    }));
    await x.controller().tick("classification");
    assert.equal(
      (await x.controller().tick("classification")).state,
      "no_improvement",
    );
  }
  assert.deepEqual((histories[2] as unknown[]).length, 2);
  const before = x.counts();
  assert.equal(
    (await x.controller().tick("classification")).reason,
    "repeated_failures_require_review",
  );
  assert.deepEqual(x.counts(), before);
  await x.controller().resume("classification");
  assert.equal(
    (await x.controller().tick("classification")).reason,
    "unchanged_evidence",
    "Resume must not erase failed decision keys.",
  );
  assert.ok(
    (await x.loop.list("events", { limit: 100 })).items.some(
      (e) => e.type === "improvement.administrative_resume",
    ),
  );
});
test("run inspection distinguishes actual charges from unresolved reservations", async () => {
  const x = setup();
  const result = await x.controller().tick("classification");
  const run = (await x.controller().getRun(result.runId!))!;
  assert.equal(run.accounting?.chargedOrReservedTokens, 40);
  assert.equal(run.accounting?.modelRequests, 1);
  assert.deepEqual(run.accounting?.outstandingOperations, []);
  const y = setup();
  y.workflow.propose = async (_, c) =>
    c.meter(100, async () => {
      throw Error("unknown completion");
    });
  const failed = await y.controller().tick("classification"),
    pending = (await y.controller().getRun(failed.runId!))!;
  assert.equal(pending.accounting?.chargedOrReservedTokens, 100);
  assert.equal(pending.accounting?.outstandingOperations.length, 1);
});
test("custom audit uncertainty must match trusted version and assumptions", () => {
  const x = setup(),
    report = {
      cases: x.data.audit.map((r) => ({
        id: r.id,
        baseline: 0,
        candidate: 0.5,
      })),
      metrics: { errors: 0 },
      estimatedServingCost: 0,
      uncertainty: {
        method: "trusted-paired",
        version: "1",
        lowerBound: 0.2,
        assumptionsValid: true,
      },
    };
  x.workflow.policy.auditMethod = { name: "trusted-paired", version: "1" };
  assert.equal(
    compare(report, x.data.audit, x.workflow.policy, true).passed,
    true,
  );
  report.uncertainty.assumptionsValid = false;
  assert.throws(() => compare(report, x.data.audit, x.workflow.policy, true));
  report.uncertainty.assumptionsValid = true;
  report.uncertainty.version = "2";
  assert.throws(() => compare(report, x.data.audit, x.workflow.policy, true));
});
test("callback timeout ignores late results and retains spending", async () => {
  const x = setup();
  let finish!: () => void;
  const late = new Promise<void>((resolve) => (finish = resolve));
  x.workflow.propose = async (_, c) =>
    c.meter(100, async () => {
      await late;
      return { value: [{ score: 1 }], tokens: 1 };
    });
  const c = new ImprovementController(x.loop, {
    workflows: [x.workflow],
    mode: "autonomous",
    selfImproving: true,
    callbackTimeoutMs: 20,
  });
  const r = await c.tick("classification");
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.state, "failed");
  assert.equal(r.reason, "timeout");
  assert.equal(r.budget.tokens, 100);
  assert.equal((await c.getRun(r.runId!))!.data.candidateIds.length, 0);
});
test("cancellation does not accept late uncooperative proposals", async () => {
  const x = setup();
  const abort = new AbortController();
  let start!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => (start = resolve)),
    late = new Promise<void>((resolve) => (finish = resolve));
  x.workflow.propose = async () => {
    start();
    await late;
    return [{ score: 1 }];
  };
  const running = x.controller().tick("classification", abort.signal);
  await ready;
  abort.abort();
  const result = await running;
  finish();
  assert.equal(result.reason, "cancelled");
  assert.equal(result.candidateIds.length, 0);
  assert.ok(result.runId);
});
test("changed policy during a cycle cannot authorize deployment", async () => {
  const x = setup();
  await x.controller().tick("classification");
  x.workflow.policy.version = "2";
  const r = await x.controller().tick("classification");
  assert.equal(r.reason, "policy_changed_requires_recovery");
  assert.equal(x.registry.applications, 0);
});
test("pinned model configuration changes after dispatch block observation and new changes", async () => {
  const x = setup();
  const artifact = x.workflow.artifact;
  let drift = false;
  x.workflow.artifact = async (c) => ({
    ...(await artifact(c)),
    configurationHash: drift ? "model-v2" : "model-v1",
  });
  const apply = x.registry.apply.bind(x.registry);
  x.registry.apply = async (r) => {
    const receipt = await apply(r);
    drift = true;
    return receipt;
  };
  for (let i = 0; i < 3; i++) await x.controller().tick("classification");
  const result = await x.controller().tick("classification");
  assert.equal(result.state, "reconciliation_required");
  assert.equal(result.reason, "out_of_band_change");
  assert.equal(x.registry.applications, 1);
});
test("bounded prompt schema counts Unicode characters consistently", () => {
  validateChange("🌀", { type: "string", maxLength: 1 });
  assert.throws(() => validateChange("🌀x", { type: "string", maxLength: 1 }));
});
test("stable cohorts retain assignment as exposure increases", () => {
  const a = assignCohort({
    experimentId: "test",
    entityId: "customer-🌀",
    salt: "private-salt",
    exposure: 0.25,
  });
  const b = assignCohort({
    experimentId: "test",
    entityId: "customer-🌀",
    salt: "private-salt",
    exposure: 0.75,
  });
  assert.equal(a.bucket, b.bucket);
  assert.equal(a.entityFingerprint, b.entityFingerprint);
  assert.equal(
    assignCohort({
      experimentId: "test",
      entityId: "customer-🌀",
      salt: "private-salt",
      exposure: 1,
    }).cohort,
    "candidate",
  );
});
