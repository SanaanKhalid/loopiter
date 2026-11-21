import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FeedbackLoop,
  InMemoryStore,
  ImprovementController,
  improvementWorkDisabled,
  failureDetailText,
  servedAnswerId,
  prepareDataset,
  compare,
  minimumCertifiableAuditUnits,
  validatePolicy,
  type AutonomyPolicy,
  type DatasetSnapshot,
  type ImprovementWorkflow,
  type DeploymentRequest,
} from "../src/index.js";
import { Registry } from "./helpers.js";
import { assignCohort, validateChange } from "../src/index.js";
import { JsonFileStore } from "../src/stores/json-file.js";
import { hash } from "../src/utils.js";

const failureDetailProbes = JSON.parse(
  await readFile(
    new URL("../../python/tests/fixtures/failure-detail-probes.json", import.meta.url),
    "utf8",
  ),
) as { cases: { input: string; output: string }[] };

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
  store: InMemoryStore = new InMemoryStore(),
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
      store,
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
  const controller = (
    extra: {
      callbackTimeoutMs?: number;
      stepTimeoutMs?: number;
      tickTimeoutMs?: number;
    } = {},
  ) =>
    new ImprovementController(loop, {
      mode: "autonomous",
      selfImproving: true,
      workflows: [workflow],
      ...extra,
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
test("omitted controller mode is autonomous and self-improving", async () => {
  const x = setup();
  const controller = new ImprovementController(x.loop, {
    workflows: [x.workflow],
  });
  let result = await controller.tick("classification");
  for (
    let i = 0;
    i < 8 &&
    !["completed", "no_improvement", "rolled_back", "waiting_for_evidence"].includes(
      result.state,
    );
    i++
  ) {
    if (result.state === "observing") x.advance();
    result = await controller.tick("classification");
  }
  assert.equal(result.state, "completed");
  assert.equal(x.registry.applications, 1);
  const page = await x.loop.list("coordination", { limit: 1000 });
  const row = page.items.find((item) => item.id === "workflow:classification");
  assert.equal(row?.data.mode, "autonomous");
  assert.equal(row?.data.selfImproving, true);
});
test("recommend mode stores a proposal and never applies", async () => {
  const x = setup();
  const controller = new ImprovementController(x.loop, {
    workflows: [x.workflow],
    mode: "recommend",
  });
  const result = await controller.tick("classification");
  assert.equal(result.state, "completed");
  assert.equal(result.reason, "recommendations_only");
  assert.equal(x.registry.applications, 0);
  assert.equal(x.counts().proposals, 1);
  const again = await controller.tick("classification");
  assert.equal(again.reason, "unchanged_evidence");
  assert.equal(x.registry.applications, 0);
});
test("disable pauses every mode before a provider callback", async () => {
  for (const mode of ["recommend", "experiment", "observe", "autonomous"] as const) {
    const x = setup();
    let calls = 0;
    const touch = async () => {
      calls += 1;
      throw new Error("provider");
    };
    x.workflow.artifact = touch;
    x.workflow.dataset = touch;
    x.workflow.propose = touch;
    const result = await new ImprovementController(x.loop, {
      workflows: [x.workflow],
      mode,
      selfImproving: false,
    }).tick("classification");
    assert.equal(result.state, "paused", mode);
    assert.equal(result.reason, "self_improvement_disabled", mode);
    assert.equal(calls, 0, mode);
    assert.equal(x.registry.applications, 0, mode);
  }
});
test("opt-out idles autonomous, experiment, and observe", async () => {
  for (const mode of ["autonomous", "experiment", "observe"] as const) {
    const x = setup();
    let calls = 0;
    const touch = async () => {
      calls += 1;
      throw new Error("provider");
    };
    x.workflow.artifact = touch;
    x.workflow.dataset = touch;
    x.workflow.propose = touch;
    const result = await new ImprovementController(x.loop, {
      workflows: [x.workflow],
      mode,
      selfImproving: false,
    }).tick("classification");
    assert.equal(result.state, "paused", mode);
    assert.equal(result.reason, "self_improvement_disabled", mode);
    assert.equal(calls, 0, mode);
    assert.equal(x.registry.applications, 0, mode);
    assert.equal(x.counts().proposals, 0, mode);
  }
});
test("self-improving on follows each mode gate", async () => {
  const paused = setup();
  const pausedController = new ImprovementController(paused.loop, {
    workflows: [paused.workflow],
    mode: "autonomous",
    selfImproving: true,
  });
  await pausedController.pause("classification", "operator pause");
  const held = await pausedController.tick("classification");
  assert.equal(held.state, "paused");
  assert.equal(held.reason, "workflow_paused");
  assert.equal(paused.counts().proposals, 0);
  assert.equal(paused.registry.applications, 0);

  const running = setup();
  const autonomous = new ImprovementController(running.loop, {
    workflows: [running.workflow],
    mode: "autonomous",
    selfImproving: true,
  });
  let result = await autonomous.tick("classification");
  for (
    let i = 0;
    i < 8 &&
    !["completed", "no_improvement", "rolled_back", "waiting_for_evidence"].includes(
      result.state,
    );
    i++
  ) {
    if (result.state === "observing") running.advance();
    result = await autonomous.tick("classification");
  }
  assert.equal(result.state, "completed");
  assert.equal(running.registry.applications, 1);
  assert.ok(running.counts().proposals > 0);

  const experiment = setup();
  const experimental = new ImprovementController(experiment.loop, {
    workflows: [experiment.workflow],
    mode: "experiment",
    selfImproving: true,
  });
  let audited = await experimental.tick("classification");
  for (let i = 0; i < 8 && audited.state !== "completed"; i++)
    audited = await experimental.tick("classification");
  assert.equal(audited.state, "completed");
  assert.equal(audited.reason, "experiment_only");
  assert.equal(experiment.registry.applications, 0);
  assert.ok(experiment.counts().proposals > 0);

  const observe = setup();
  let reads = 0;
  const artifact = observe.workflow.artifact;
  observe.workflow.artifact = async (context) => {
    reads += 1;
    return artifact(context);
  };
  const seen = await new ImprovementController(observe.loop, {
    workflows: [observe.workflow],
    mode: "observe",
    selfImproving: true,
  }).tick("classification");
  assert.equal(seen.reason, "observation_only");
  assert.equal(seen.state, "waiting_for_evidence");
  assert.ok(reads > 0);
  assert.equal(observe.counts().proposals, 0);
  assert.equal(observe.registry.applications, 0);
});
test("null mode is rejected and LOOPITER_DISABLE fails closed", async () => {
  const x = setup();
  assert.throws(
    () =>
      new ImprovementController(x.loop, {
        workflows: [x.workflow],
        mode: null as never,
      }),
    { code: "invalid_input" },
  );
  const previous = process.env.LOOPITER_DISABLE;
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["NO", false],
    [" off ", false],
    ["1", true],
    ["true", true],
    ["yes", true],
    ["on", true],
    ["y", true],
    ["enabled", true],
    ["disable", true],
    ["disabled", true],
    [" TRUE ", true],
  ];
  try {
    for (const [value, disabled] of cases) {
      if (value === undefined) delete process.env.LOOPITER_DISABLE;
      else process.env.LOOPITER_DISABLE = value;
      assert.equal(improvementWorkDisabled(), disabled, JSON.stringify(value));
      const run = setup();
      let calls = 0;
      run.workflow.propose = async () => {
        calls += 1;
        return [{ score: 1 }];
      };
      const result = await new ImprovementController(run.loop, {
        workflows: [run.workflow],
        mode: "experiment",
      }).tick("classification");
      if (disabled) {
        assert.equal(result.reason, "self_improvement_disabled", JSON.stringify(value));
        assert.equal(calls, 0, JSON.stringify(value));
      } else {
        assert.notEqual(result.reason, "self_improvement_disabled", JSON.stringify(value));
        assert.equal(calls, 1, JSON.stringify(value));
      }
    }
  } finally {
    if (previous === undefined) delete process.env.LOOPITER_DISABLE;
    else process.env.LOOPITER_DISABLE = previous;
  }
});
test("default autonomous mode blocks a losing candidate", async () => {
  const x = setup({ name: "rejected", scores: [0], errors: 0 });
  const controller = new ImprovementController(x.loop, {
    workflows: [x.workflow],
  });
  let result = await controller.tick("classification");
  for (let i = 0; i < 8 && result.state !== "no_improvement"; i++)
    result = await controller.tick("classification");
  assert.equal(result.state, "no_improvement");
  assert.equal(result.reason, "validation_failed");
  assert.equal(x.registry.applications, 0);
});
test("confidence mode waits when decisive items are short and still rejects a real loss", async () => {
  const waiting = setup({ name: "sparse", scores: [1], errors: 0 });
  waiting.workflow.policy.objective = {
    ...waiting.workflow.policy.objective,
    acceptance: "confidence",
    minimumEffect: 0,
    confidence: 0.9,
    bootstrapSamples: 200,
    bootstrapSeed: 17,
  };
  waiting.workflow.evaluate = async (input) => ({
    cases: input.examples.map((row, index) => ({
      id: row.id,
      baseline: 0,
      candidate: input.partition === "validation" && index < 2 ? 1 : 0,
    })),
    metrics: { errors: 0 },
    estimatedServingCost: 1,
  });
  let result = await waiting.controller().tick("classification");
  for (let i = 0; i < 6 && result.reason !== "insufficient_decisive"; i++)
    result = await waiting.controller().tick("classification");
  assert.equal(result.state, "waiting_for_evidence");
  assert.equal(result.reason, "insufficient_decisive");
  assert.equal(waiting.registry.applications, 0);
  const run = (await waiting.controller().getRun(result.runId!))!;
  assert.equal(run.data.acceptance?.outcome, "insufficient");
  assert.equal(run.data.acceptance?.split, "validation");
  assert.equal(run.data.acceptance?.decisive, 2);
  assert.equal(run.data.acceptance?.required, 5);
  assert.equal(run.data.acceptance?.lower, null);
  for (const id of run.data.candidateIds)
    assert.equal((await waiting.loop.getCandidate(id))?.status, "proposed");
  const again = await waiting.controller().tick("classification");
  assert.equal(again.reason, "unchanged_evidence");
  assert.equal(again.state, "waiting_for_evidence");
  const coordination = await waiting.loop.list("coordination", { limit: 100 });
  const target = coordination.items.find((row) => String(row.id).startsWith("target:"));
  assert.equal(target?.data.consecutiveFailures ?? 0, 0);
  assert.equal(target?.data.activeRun ?? null, null);

  const loss = setup({ name: "loss", scores: [0], errors: 0 });
  loss.workflow.policy.objective = {
    ...loss.workflow.policy.objective,
    acceptance: "confidence",
    minimumEffect: 0,
    confidence: 0.9,
    bootstrapSamples: 200,
    bootstrapSeed: 17,
  };
  loss.workflow.evaluate = async (input) => ({
    cases: input.examples.map((row) => ({ id: row.id, baseline: 1, candidate: 0 })),
    metrics: { errors: 0 },
    estimatedServingCost: 1,
  });
  let rejected = await loss.controller().tick("classification");
  for (let i = 0; i < 6 && rejected.reason !== "validation_failed"; i++)
    rejected = await loss.controller().tick("classification");
  assert.equal(rejected.state, "no_improvement");
  assert.equal(rejected.reason, "validation_failed");
  assert.equal(loss.registry.applications, 0);
  const lossLock = (await loss.loop.list("coordination", { limit: 100 })).items.find((row) =>
    String(row.id).startsWith("target:"),
  );
  assert.equal(lossLock?.data.consecutiveFailures, 1);

  const audit = setup({ name: "audit-short", scores: [1], errors: 0 });
  audit.workflow.policy.objective = {
    ...audit.workflow.policy.objective,
    acceptance: "confidence",
    minimumEffect: 0,
    confidence: 0.9,
    bootstrapSamples: 200,
    bootstrapSeed: 17,
  };
  audit.workflow.evaluate = async (input) => ({
    cases: input.examples.map((row, index) => ({
      id: row.id,
      baseline: 0,
      candidate: input.partition === "audit" ? (index < 2 ? 1 : 0) : 1,
    })),
    metrics: { errors: 0 },
    estimatedServingCost: 1,
  });
  let held = await audit.controller().tick("classification");
  for (let i = 0; i < 8 && held.reason !== "insufficient_decisive"; i++)
    held = await audit.controller().tick("classification");
  assert.equal(held.state, "waiting_for_evidence");
  assert.equal(held.reason, "insufficient_decisive");
  assert.equal(audit.registry.applications, 0);
  const audited = (await audit.controller().getRun(held.runId!))!;
  assert.equal(audited.data.acceptance?.split, "audit");
  assert.equal(audited.data.acceptance?.decisive, 2);
  const candidate = await audit.loop.getCandidate(audited.data.selectedId!);
  const evaluation = candidate?.evaluations.at(-1);
  assert.equal(candidate?.status, "evaluated");
  assert.equal(evaluation?.passed, false);
  assert.equal(evaluation?.outcome, "insufficient");
  assert.equal(evaluation?.reason, "insufficient_decisive");
  assert.match(evaluation?.notes ?? "", /2 of 5/);
  assert.match(evaluation?.notes ?? "", /not a rejection/);
  assert.equal(evaluation?.metrics?.decisiveItems, 2);
  assert.equal(evaluation?.metrics?.requiredDecisive, 5);
});

test("confidence policies reject a short partition and a non-integer decisive floor", () => {
  const base = structuredClone(fixtures.policy) as AutonomyPolicy;
  base.objective = { ...base.objective, acceptance: "confidence", minimumEffect: 0 };
  assert.doesNotThrow(() => validatePolicy(base));
  const short = structuredClone(base);
  short.minimumValidationUnits = 4;
  assert.throws(() => validatePolicy(short), { code: "invalid_policy" });
  const above = structuredClone(base);
  above.objective = { ...above.objective, minimumValidationDecisive: 100 };
  assert.throws(() => validatePolicy(above), { code: "invalid_policy" });
  const zero = structuredClone(base);
  zero.objective = { ...zero.objective, minimumAuditDecisive: 0 };
  assert.throws(() => validatePolicy(zero), { code: "invalid_input" });
  const fractional = structuredClone(base);
  fractional.objective = { ...fractional.objective, minimumValidationDecisive: 1.5 };
  assert.throws(() => validatePolicy(fractional), { code: "invalid_input" });
  const under = structuredClone(base);
  under.objective = { ...under.objective, minimumValidationDecisive: 4 };
  assert.throws(() => validatePolicy(under), { code: "invalid_policy" });
  const auditUnder = structuredClone(base);
  auditUnder.objective = { ...auditUnder.objective, minimumAuditDecisive: 4 };
  assert.throws(() => validatePolicy(auditUnder), { code: "invalid_policy" });
  const atFloor = structuredClone(base);
  atFloor.objective = {
    ...atFloor.objective,
    minimumValidationDecisive: 5,
    minimumAuditDecisive: 5,
  };
  assert.doesNotThrow(() => validatePolicy(atFloor));
  const fixed = structuredClone(fixtures.policy) as AutonomyPolicy;
  fixed.objective = { ...fixed.objective, minimumValidationDecisive: 5 };
  assert.throws(() => validatePolicy(fixed), { code: "invalid_policy" });
  const noise = structuredClone(base);
  noise.objective = { ...noise.objective, noiseFloor: { validation: true, audit: false } };
  assert.doesNotThrow(() => validatePolicy(noise));
  const fixedNoise = structuredClone(fixtures.policy) as AutonomyPolicy;
  fixedNoise.objective = { ...fixedNoise.objective, noiseFloor: { audit: true } };
  assert.throws(() => validatePolicy(fixedNoise), { code: "invalid_policy" });
  const badFlag = structuredClone(base);
  badFlag.objective = {
    ...badFlag.objective,
    noiseFloor: { validation: "yes" as unknown as boolean },
  };
  assert.throws(() => validatePolicy(badFlag), { code: "invalid_policy" });
  const extra = structuredClone(base);
  Object.assign(extra.objective, { noiseFloor: { validation: true, samples: 10 } });
  assert.throws(() => validatePolicy(extra));
  const kept = structuredClone(base);
  kept.objective = { ...kept.objective, retention: { margin: 0.02 } };
  assert.doesNotThrow(() => validatePolicy(kept));
  const withConfidence = structuredClone(base);
  withConfidence.objective = {
    ...withConfidence.objective,
    retention: { margin: 0, confidence: 0.8 },
  };
  assert.doesNotThrow(() => validatePolicy(withConfidence));
  const fixedRetention = structuredClone(fixtures.policy) as AutonomyPolicy;
  fixedRetention.objective = { ...fixedRetention.objective, retention: { margin: 0.02 } };
  assert.throws(() => validatePolicy(fixedRetention), { code: "invalid_policy" });
  const missingMargin = structuredClone(base);
  missingMargin.objective = { ...missingMargin.objective, retention: {} as { margin: number } };
  assert.throws(() => validatePolicy(missingMargin), { code: "invalid_policy" });
  const negative = structuredClone(base);
  negative.objective = { ...negative.objective, retention: { margin: -0.01 } };
  assert.throws(() => validatePolicy(negative), { code: "invalid_input" });
  const badConfidence = structuredClone(base);
  badConfidence.objective = {
    ...badConfidence.objective,
    retention: { margin: 0.1, confidence: 1 },
  };
  assert.throws(() => validatePolicy(badConfidence), { code: "invalid_policy" });
  const extraRetention = structuredClone(base);
  Object.assign(extraRetention.objective, { retention: { margin: 0.1, samples: 10 } });
  assert.throws(() => validatePolicy(extraRetention));
  assert.doesNotThrow(() => validatePolicy(structuredClone(fixtures.policy)));
});

function retentionReady(
  scores: number[],
  margin: number,
  productionErrors = 0,
  store?: InMemoryStore,
) {
  const scenario = { name: "accepted", scores, errors: 0, productionErrors };
  const x = store ? setup(scenario, store) : setup(scenario);
  x.workflow.policy.objective = {
    ...x.workflow.policy.objective,
    acceptance: "confidence",
    minimumEffect: 0,
    confidence: 0.9,
    bootstrapSamples: 200,
    bootstrapSeed: 17,
    retention: { margin },
  };
  x.workflow.policy.daily = { modelRequests: 20, tokens: 5000, deployments: 5 };
  return x;
}

class TracingStore extends InMemoryStore {
  batches: { kind: string; state?: string; bestId?: string }[][] = [];
  override async transaction<T>(
    namespace: string,
    operation: (tx: import("../src/store.js").StoreTransaction) => Promise<T>,
  ): Promise<T> {
    const batch: { kind: string; state?: string; bestId?: string }[] = [];
    const result = await super.transaction(namespace, async (tx) => {
      const note = (kind: string, record: { data?: { state?: string; retention?: { bestEver?: { id?: string } } } }) => {
        const write: { kind: string; state?: string; bestId?: string } = { kind };
        if (record.data?.state !== undefined) write.state = record.data.state;
        const bestId = record.data?.retention?.bestEver?.id;
        if (bestId !== undefined) write.bestId = bestId;
        batch.push(write);
      };
      return operation({
        get: tx.get.bind(tx),
        list: tx.list.bind(tx),
        insert: async (kind, record) => {
          note(kind, record as { data?: { state?: string; retention?: { bestEver?: { id?: string } } } });
          return tx.insert(kind, record);
        },
        replace: async (kind, record, expected) => {
          note(kind, record as { data?: { state?: string; retention?: { bestEver?: { id?: string } } } });
          return tx.replace(kind, record, expected);
        },
      });
    });
    if (batch.length) this.batches.push(batch);
    return result;
  }
}

function auditScores(score: number, count = 50) {
  return Array.from({ length: count }, (_, index) => ({
    id: `customer-audit-${index}`,
    score,
  }));
}

async function seedBestEver(
  x: ReturnType<typeof setup>,
  score: number,
  count = 50,
) {
  const now = "2026-02-01T00:00:00.000Z";
  await x.loop.store.transaction(x.loop.namespace, async (tx) => {
    await tx.insert("coordination", {
      id: `target:${hash(x.workflow.policy.target)}`,
      namespace: x.loop.namespace,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      format: 1,
      data: {
        retention: {
          bestEver: { id: "seeded", score, items: auditScores(score, count) },
          decisions: [],
        },
      },
    });
  });
}

test("a first promotion records not_measured and then the best-ever score", async () => {
  const x = retentionReady([0.5], 0.05);
  const controller = x.controller();
  const result = await finishRetention(x, controller);
  assert.equal(result.state, "completed", JSON.stringify(result));
  const run = (await controller.getRun(result.runId!))!;
  assert.equal(run.data.retention?.outcome, "not_measured");
  assert.equal(run.data.retention?.lower, null);
  assert.equal(run.data.retention?.margin, null);
  assert.equal(run.data.retention?.items, null);
  assert.equal(run.data.retention?.bestEverId, null);
  const ledger = await retentionLedger(x);
  assert.equal(ledger.bestEver?.score, 0.5);
  assert.equal(ledger.bestEver?.id, run.data.selectedId);
  assert.equal(ledger.decisions.at(-1)?.items, null);
});

test("retention regression blocks promotion and does not move best-ever", async () => {
  const x = retentionReady([0.25], 0.05);
  await seedBestEver(x, 1);
  const result = await finishRetention(x, x.controller());
  assert.equal(result.state, "no_improvement");
  assert.equal(result.reason, "retention_regression");
  assert.equal(x.registry.applications, 0);
  const ledger = await retentionLedger(x);
  assert.equal(ledger.bestEver?.id, "seeded");
  assert.equal(ledger.bestEver?.score, 1);
  assert.equal(ledger.decisions.at(-1)?.outcome, "retention_regression");
  assert.ok((ledger.decisions.at(-1)?.lower ?? 0) < -0.05);
  assert.equal((await targetLock(x)).consecutiveFailures, 1);
});

test("a passing promotion updates best-ever only when the control score is higher", async () => {
  const x = retentionReady([0.5], 0.5);
  await seedBestEver(x, 0.75);
  const result = await finishRetention(x, x.controller());
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(x.registry.applications, 1);
  const ledger = await retentionLedger(x);
  assert.equal(ledger.bestEver?.id, "seeded");
  assert.equal(ledger.bestEver?.score, 0.75);
  assert.equal(ledger.decisions.at(-1)?.outcome, "pass");
});

test("a rolled-back promotion never becomes best-ever", async () => {
  const x = retentionReady([1], 0.05, 0.5);
  await seedBestEver(x, 0.5);
  const controller = x.controller();
  let rising = await controller.tick("classification");
  for (let i = 0; i < 8 && rising.state !== "observing" && rising.state !== "rolling_back"; i++)
    rising = await controller.tick("classification");
  assert.equal(rising.state, "observing", JSON.stringify(rising));
  const promoted = (await controller.getRun(rising.runId!))!;
  let ledger = await retentionLedger(x);
  assert.equal(ledger.bestEver?.id, "seeded");
  assert.equal(ledger.bestEver?.score, 0.5);
  assert.notEqual(ledger.bestEver?.id, promoted.data.selectedId);
  x.advance(2);
  let rolled = await controller.tick("classification");
  for (let i = 0; i < 4 && rolled.state !== "rolled_back"; i++)
    rolled = await controller.tick("classification");
  assert.equal(rolled.state, "rolled_back", JSON.stringify(rolled));
  ledger = await retentionLedger(x);
  assert.equal(ledger.bestEver?.id, "seeded");
  assert.equal(ledger.bestEver?.score, 0.5);
  assert.notEqual(ledger.bestEver?.id, promoted.data.selectedId);
});

test("completed state and the best-ever record are saved in one transaction", async () => {
  const tracing = new TracingStore();
  const x = retentionReady([1], 0.05, 0, tracing);
  await seedBestEver(x, 0.5);
  const result = await finishRetention(x, x.controller());
  assert.equal(result.state, "completed", JSON.stringify(result));
  const selected = (await x.controller().getRun(result.runId!))!.data.selectedId;
  const saving = tracing.batches.filter(
    (batch) =>
      batch.some((write) => write.kind === "runs" && write.state === "completed") &&
      batch.some((write) => write.kind === "coordination" && write.bestId === selected),
  );
  assert.equal(saving.length, 1);
  const before = tracing.batches.indexOf(saving[0]!);
  assert.equal(
    tracing.batches.slice(0, before).some((batch) => batch.some((write) => write.bestId === selected)),
    false,
  );
});

test("retention status reads the coordination row a controller run wrote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retention-store-"));
  const file = join(directory, "state.json");
  const store = new JsonFileStore(file);
  try {
    const x = retentionReady([1], 0.05, 0, store);
    const controller = x.controller();
    const result = await finishRetention(x, controller);
    assert.equal(result.state, "completed", JSON.stringify(result));
    const selected = (await controller.getRun(result.runId!))!.data.selectedId!;
    await store.close();
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    const cli = fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url));
    const args = ["retention", "status", "--file", file, "--namespace", "test", "--json"];
    const node = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const python = spawnSync("python3", ["-m", "loopiter", ...args], {
      cwd: repo,
      env: { ...process.env, PYTHONPATH: join(repo, "python/src") },
      encoding: "utf8",
    });
    assert.equal(node.status, 0, node.stderr);
    assert.equal(python.status, 0, python.stderr);
    assert.equal(python.stdout, node.stdout);
    const parsed = JSON.parse(node.stdout) as {
      targets: { id: string; bestEver: { id: string; score: number } }[];
    };
    assert.equal(parsed.targets.length, 1);
    assert.equal(parsed.targets[0]?.bestEver.id, selected);
    assert.equal(parsed.targets[0]?.bestEver.score, 1);
    assert.equal(parsed.targets[0]?.id.startsWith("target:"), true);
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid best-ever record fails closed and is not replaced", async () => {
  const x = retentionReady([1], 0.05);
  const now = "2026-02-01T00:00:00.000Z";
  await x.loop.store.transaction(x.loop.namespace, async (tx) => {
    await tx.insert("coordination", {
      id: `target:${hash(x.workflow.policy.target)}`,
      namespace: x.loop.namespace,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      format: 1,
      data: {
        retention: {
          bestEver: {
            id: "bad",
            score: 1,
            items: [
              { id: "customer-audit-0", score: 1 },
              { id: "customer-audit-0", score: 1 },
            ],
          },
          decisions: [],
        },
      },
    });
  });
  const controller = x.controller();
  let result = await controller.tick("classification");
  for (let i = 0; i < 8 && result.reason !== "invalid_retention"; i++)
    result = await controller.tick("classification");
  assert.equal(result.reason, "invalid_retention");
  assert.match(result.detail ?? "", /Duplicate retention best-ever item id/);
  assert.equal(x.registry.applications, 0);
  const rows = await x.loop.list("coordination", { limit: 1000 });
  const target = rows.items.find((row) => String(row.id).startsWith("target:"));
  const kept = target?.data.retention as { bestEver?: { id?: string } };
  assert.equal(kept.bestEver?.id, "bad");
});

test("too few overlapping items is insufficient and does not deploy", async () => {
  const x = retentionReady([0.5], 0.05);
  await seedBestEver(x, 1, 2);
  const result = await finishRetention(x, x.controller());
  assert.equal(result.state, "waiting_for_evidence");
  assert.equal(result.reason, "insufficient_decisive");
  assert.equal(x.registry.applications, 0);
  const run = (await x.controller().getRun(result.runId!))!;
  assert.equal(run.data.retention?.outcome, "insufficient");
  assert.equal(run.data.retention?.lower, null);
  assert.equal(run.data.retention?.items, 2);
  const ledger = await retentionLedger(x);
  assert.equal(ledger.bestEver?.score, 1);
  assert.equal((await targetLock(x)).consecutiveFailures ?? 0, 0);
});

async function finishRetention(
  x: ReturnType<typeof setup>,
  controller: ImprovementController,
) {
  let result = await controller.tick("classification");
  for (
    let i = 0;
    i < 10 &&
    !["completed", "no_improvement", "rolled_back", "waiting_for_evidence"].includes(result.state);
    i++
  ) {
    if (result.state === "observing") x.advance(2);
    result = await controller.tick("classification");
  }
  return result;
}

async function retentionLedger(x: ReturnType<typeof setup>) {
  const lock = await targetLock(x);
  return (lock.retention ?? { bestEver: null, decisions: [] }) as {
    bestEver: { id: string; score: number } | null;
    decisions: { outcome: string; lower: number | null; items: number | null }[];
  };
}

async function targetLock(x: ReturnType<typeof setup>) {
  const rows = await x.loop.list("coordination", { limit: 1000 });
  const target = rows.items.find((row) => String(row.id).startsWith("target:"));
  return (target?.data ?? {}) as {
    consecutiveFailures?: number;
    retention?: unknown;
  };
}

test("autonomous fails closed without audit, budget, or enable", async () => {
  const disabled = setup();
  const paused = await new ImprovementController(disabled.loop, {
    mode: "autonomous",
    selfImproving: false,
    workflows: [disabled.workflow],
  }).tick("classification");
  assert.equal(paused.reason, "self_improvement_disabled");
  assert.equal(paused.state, "paused");
  assert.equal(disabled.registry.applications, 0);
  assert.equal(disabled.counts().proposals, 0);
  const unaudited = setup({ name: "insufficient", scores: [1], errors: 0 });
  const waiting = await unaudited.controller().tick("classification");
  assert.equal(waiting.reason, "insufficient_evidence");
  assert.equal(waiting.state, "waiting_for_evidence");
  assert.equal(unaudited.registry.applications, 0);
  delete (disabled.workflow.policy.daily as Partial<AutonomyPolicy["daily"]>)
    .tokens;
  assert.throws(() => disabled.controller(), { code: "invalid_input" });
  assert.equal(disabled.registry.applications, 0);
});
test("flag, exact schema and required budgets fail closed", async () => {
  const x = setup();
  assert.equal(
    (
      await new ImprovementController(x.loop, {
        mode: "autonomous",
        selfImproving: false,
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
test("honor the disable setting in all apply paths", async () => {
  const previous = process.env.LOOPITER_DISABLE;
  try {
    const x = setup();
    x.workflow.policy.rollout.mode = "canary";
    let promotions = 0;
    x.workflow.rollout = {
      promote: async () => {
        promotions++;
      },
      inspect: async () => "promoted",
    };
    const observe = x.workflow.observe;
    x.workflow.observe = async (input, context) => ({
      ...(await observe(input, context)),
      controlVersion: input.baseline.artifactVersion,
      assignmentHash: "stable-cohort-v1",
      controlUnitIds: Array.from({ length: 10 }, (_, n) => `control-${n}`),
      improvementLowerBound: 0.5,
    });
    for (let i = 0; i < 4; i++) await x.controller().tick("classification");
    x.advance();
    process.env.LOOPITER_DISABLE = "1";
    const held = await x.controller().tick("classification");
    assert.equal(held.reason, "promotion_paused");
    assert.equal(promotions, 0);

    delete process.env.LOOPITER_DISABLE;
    const applied = setup();
    let ready = await applied.controller().tick("classification");
    for (let i = 0; i < 8 && ready.reason !== "audit_passed"; i++)
      ready = await applied.controller().tick("classification");
    assert.equal(ready.reason, "audit_passed");
    assert.equal(applied.registry.applications, 0);
    process.env.LOOPITER_DISABLE = "1";
    const blocked = await applied.controller().tick("classification");
    assert.equal(blocked.reason, "self_improvement_disabled");
    assert.equal(applied.registry.applications, 0);

    delete process.env.LOOPITER_DISABLE;
    const recovering = setup({
      name: "regression",
      scores: [1],
      errors: 0,
      productionErrors: 1,
    });
    for (let i = 0; i < 4; i++)
      await recovering.controller().tick("classification");
    recovering.advance();
    assert.equal(
      (await recovering.controller().tick("classification")).state,
      "rolling_back",
    );
    process.env.LOOPITER_DISABLE = "1";
    assert.equal(
      (await recovering.controller().tick("classification")).state,
      "rolled_back",
    );
  } finally {
    if (previous === undefined) delete process.env.LOOPITER_DISABLE;
    else process.env.LOOPITER_DISABLE = previous;
  }
});
test("tighten the disable check before apply", async () => {
  const previous = process.env.LOOPITER_DISABLE;
  try {
    delete process.env.LOOPITER_DISABLE;
    const x = setup();
    let ready = await x.controller().tick("classification");
    for (let i = 0; i < 8 && ready.reason !== "audit_passed"; i++)
      ready = await x.controller().tick("classification");
    assert.equal(ready.reason, "audit_passed");
    assert.equal(x.registry.applications, 0);
    const read = x.workflow.artifact;
    x.workflow.artifact = async (context) => {
      const current = await read(context);
      process.env.LOOPITER_DISABLE = "1";
      return current;
    };
    const blocked = await x.controller().tick("classification");
    assert.equal(blocked.reason, "self_improvement_disabled");
    assert.equal(blocked.state, "paused");
    assert.equal(x.registry.applications, 0);
    const again = await x.controller().tick("classification");
    assert.equal(again.reason, "self_improvement_disabled");
    assert.equal(again.state, "paused");
    const held = (await x.controller().getRun(again.runId!))!;
    assert.equal(held.data.state, "paused");
    assert.notEqual(held.data.state, "reconciliation_required");
    assert.equal(x.registry.applications, 0);
    const attempts = await x.loop.list("attempts", { limit: 100 });
    assert.equal(attempts.items.length, 0);
    const targets = await x.loop.list("targets", { limit: 100 });
    for (const target of targets.items)
      assert.equal(target.pendingAttemptId, undefined);
    const coordination = await x.loop.list("coordination", { limit: 1000 });
    const lock = coordination.items.find((row) => row.id.startsWith("target:"));
    assert.equal(lock?.data.consecutiveFailures ?? 0, 0);
    x.workflow.artifact = read;
    delete process.env.LOOPITER_DISABLE;
    let resumed = await x.controller().tick("classification");
    for (let i = 0; i < 8 && resumed.state !== "completed"; i++) {
      if (resumed.state === "observing") x.advance();
      resumed = await x.controller().tick("classification");
    }
    assert.equal(resumed.state, "completed");
    assert.equal(x.registry.applications, 1);
  } finally {
    if (previous === undefined) delete process.env.LOOPITER_DISABLE;
    else process.env.LOOPITER_DISABLE = previous;
  }
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
  assert.equal(r.state, "proposing");
  assert.equal(r.reason, "timed_out");
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

test("batched evaluation resumes across controllers and runs at most one batch per tick", async () => {
  const x = setup();
  x.workflow.policy.target.kind = "agent_release";
  x.workflow.evaluationBatchSize = 4;
  const dispatched = new Set<string>();
  let batchCalls = 0;
  x.workflow.evaluateBatch = async (input, context) => {
    assert.ok(input.examples.length <= 4);
    assert.ok(
      !dispatched.has(context.operationId),
      "batch must not be replayed",
    );
    dispatched.add(context.operationId);
    batchCalls++;
    return input.examples.map((row) => ({
      id: row.id,
      baseline: 0,
      candidate: (input.change as { score: number }).score,
    }));
  };
  x.workflow.evaluate = async (input) => ({
    cases: input.batchResults!.flat() as unknown as {
      id: string;
      baseline: number;
      candidate: number;
    }[],
    metrics: { errors: 0 },
    estimatedServingCost: 1,
  });
  let result;
  for (let i = 0; i < 60; i++) {
    const before = batchCalls;
    result = await x.controller().tick("classification");
    assert.ok(batchCalls - before <= 1, "only one live batch per tick");
    if (result.state === "observing") x.advance();
    if (result.state === "completed") break;
    assert.notEqual(result.state, "failed", result.reason);
  }
  assert.equal(result!.state, "completed");
  assert.equal(batchCalls, 23); // 2 * ceil(20/4) validation + ceil(50/4) audit
  assert.equal(x.registry.applications, 1);
});

test("batch configuration is pinned and invalid batch sizes are rejected", () => {
  const x = setup();
  x.workflow.evaluationBatchSize = 33;
  assert.throws(() => x.controller(), { code: "invalid_input" });
});
test("step timeout can be raised and a timed-out audit is not reused", async () => {
  const objective = {
    minimumImprovement: 0.05,
    range: [0, 1] as [number, number],
    alpha: 0.05,
  };
  assert.equal(minimumCertifiableAuditUnits(objective), 7);
  assert.ok(minimumCertifiableAuditUnits(objective, 0.2) > 7);
  const sized = setup();
  sized.workflow.policy.minimumAuditUnits = 7;
  sized.data.audit = sized.data.audit.slice(0, 7);
  assert.equal(
    compare(
      {
        cases: sized.data.audit.map((row) => ({
          id: row.id,
          baseline: 0,
          candidate: 1,
        })),
        metrics: { errors: 0 },
        estimatedServingCost: 0,
      },
      sized.data.audit,
      sized.workflow.policy,
      true,
    ).passed,
    true,
  );
  const impossible = setup();
  impossible.workflow.policy.minimumAuditUnits = 5;
  impossible.data.audit = impossible.data.audit.slice(0, 5);
  assert.equal(
    compare(
      {
        cases: impossible.data.audit.map((row) => ({
          id: row.id,
          baseline: 0,
          candidate: 1,
        })),
        metrics: { errors: 0 },
        estimatedServingCost: 0,
      },
      impossible.data.audit,
      impossible.workflow.policy,
      true,
    ).passed,
    false,
  );
  assert.equal(
    (await impossible.controller().tick("classification")).reason,
    "audit_size_cannot_certify",
  );
  const x = setup();
  assert.doesNotThrow(() => x.controller({ stepTimeoutMs: 180000 }));
  assert.doesNotThrow(() => x.controller({ stepTimeoutMs: 7_200_000 }));
  assert.throws(() => x.controller({ stepTimeoutMs: 7_200_001 }), {
    code: "invalid_input",
  });
  const original = x.workflow.evaluate;
  let auditCalls = 0;
  x.workflow.evaluate = async (input, context) => {
    if (input.partition === "audit") {
      auditCalls += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return original(input, context);
  };
  const controller = x.controller({ callbackTimeoutMs: 40 });
  let result = await controller.tick("classification");
  for (let i = 0; i < 5 && result.state !== "timed_out"; i++)
    result = await controller.tick("classification");
  assert.equal(result.state, "timed_out");
  assert.equal(result.reason, "timed_out");
  const run = (await controller.getRun(result.runId!))!;
  const coordination = await x.loop.list("coordination", { limit: 1000 });
  assert.equal(
    coordination.items.some((row) => row.id.startsWith("audit:")),
    true,
  );
  const sent = auditCalls;
  x.data.version = "export-reuse";
  x.data.optimization = x.data.optimization.map((row) => ({
    ...row,
    id: `reuse-${row.id}`,
    episodeId: `reuse-${row.episodeId}`,
    entityId: `reuse-${row.entityId}`,
  }));
  let reused = await controller.tick("classification");
  for (let i = 0; i < 8 && reused.reason !== "audit_consumed"; i++)
    reused = await controller.tick("classification");
  assert.equal(reused.reason, "audit_consumed");
  assert.equal(auditCalls, sent);
  const target = coordination.items.find((row) => row.id.startsWith("target:"));
  assert.equal(target?.data.consecutiveFailures ?? 0, 0);
  assert.equal(target?.data.consecutiveTimeouts, 1);
  for (const id of run.data.candidateIds)
    assert.equal((await x.loop.getCandidate(id))?.status, "rejected");
  const stale = await x.loop.createCandidate({
    target: x.workflow.policy.target,
    proposedChange: { score: 0.4 },
    evidence: {},
    risk: "low",
    metadata: { runId: run.id },
  });
  await x.controller().tick("classification");
  assert.equal((await x.loop.getCandidate(stale.id))?.status, "rejected");
  for (let cycle = 2; cycle <= 3; cycle++) {
    x.data.version = `export-${cycle}`;
    x.data.optimization = x.data.optimization.map((row) => ({
      ...row,
      id: `${cycle}-${row.id}`,
      episodeId: `${cycle}-${row.episodeId}`,
      entityId: `${cycle}-${row.entityId}`,
    }));
    x.data.audit = x.data.audit.map((row) => ({
      ...row,
      id: `${cycle}-${row.id}`,
      episodeId: `${cycle}-${row.episodeId}`,
      entityId: `${cycle}-${row.entityId}`,
    }));
    result = await controller.tick("classification");
    for (let i = 0; i < 5 && result.state !== "timed_out"; i++)
      result = await controller.tick("classification");
    assert.equal(result.state, "timed_out");
  }
  x.data.version = "export-4";
  x.data.optimization = x.data.optimization.map((row) => ({
    ...row,
    id: `4-${row.id}`,
    episodeId: `4-${row.episodeId}`,
    entityId: `4-${row.entityId}`,
  }));
  x.data.audit = x.data.audit.map((row) => ({
    ...row,
    id: `4-${row.id}`,
    episodeId: `4-${row.episodeId}`,
    entityId: `4-${row.entityId}`,
  }));
  assert.equal(
    (await controller.tick("classification")).reason,
    "repeated_timeouts_require_review",
  );
});

test("callback failure keeps a redacted truncated detail", async () => {
  const x = setup();
  const host = "https://secret.example.openai.azure.com/openai";
  const key = "sk-test-secret-value";
  x.workflow.propose = async () => {
    throw new Error(
      `proposal exploded at ${host} api-key: ${key} authorization: Bearer ${key} ${"y".repeat(800)}`,
    );
  };
  const controller = x.controller();
  const result = await controller.tick("classification");
  assert.equal(result.reason, "callback_failed");
  assert.equal(result.state, "failed");
  const detail = result.detail ?? "";
  assert.match(detail, /proposal exploded/);
  assert.equal(detail.includes(host), false);
  assert.equal(detail.includes("secret.example.openai.azure.com"), false);
  assert.equal(detail.includes(key), false);
  assert.ok(detail.length <= 500);
  assert.equal((await controller.getRun(result.runId!))?.data.detail, detail);
});

test("failure text redacts provider hosts and credential material", () => {
  const text = [
    "contoso.openai.azure.com",
    "myres.openai.azure.com.",
    "westus.cognitiveservices.azure.com",
    "prod.azure.com",
    "contoso.azure-api.net",
    "contoso.openai.azure.us",
    "contoso.openai.azure.cn",
    "acct.blob.core.windows.net",
    "api.openai.com",
    "Bearer sk-bearersecretvalue",
    "sk-baresecretvalue99",
    '{"api_key":"json-secret-value"}',
    "?api-key=query-secret-value&x=1",
    "x-api-key: header-secret-value",
    "apiKey=kv-secret-value",
    "API-KEY: mixed-case-secret",
    "api_key = spaced-secret",
    "api_key:\nnewline-secret",
    "api-key%3Dencoded-secret",
    "Ocp-Apim-Subscription-Key=ocp-secret-value",
    "Subscription-Key=sub-key-secret",
    "authorization: raw-auth-secret",
    "Authorization=raw-auth-eq-secret",
    "Authorization: Basic basic-auth-secret",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue",
    "AKIAABCDEFGHIJKLMNOP",
    "AccountKey=account-key-secret==",
    "?sv=2022&sig=sas-signature-secret",
    "postgres://admin:dsn-password-secret@db.internal:5432/app",
    "password=labeled-password-secret",
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "https://example.com/path?q=1",
    "y".repeat(800),
  ].join(" ");
  const detail = failureDetailText(text);
  for (const secret of [
    "contoso.openai.azure.com",
    "myres.openai.azure.com",
    "westus.cognitiveservices.azure.com",
    "prod.azure.com",
    "contoso.azure-api.net",
    "contoso.openai.azure.us",
    "contoso.openai.azure.cn",
    "acct.blob.core.windows.net",
    "api.openai.com",
    "sk-bearersecretvalue",
    "sk-baresecretvalue99",
    "json-secret-value",
    "query-secret-value",
    "header-secret-value",
    "kv-secret-value",
    "mixed-case-secret",
    "spaced-secret",
    "newline-secret",
    "encoded-secret",
    "ocp-secret-value",
    "sub-key-secret",
    "raw-auth-secret",
    "raw-auth-eq-secret",
    "basic-auth-secret",
    "eyJhbGciOiJIUzI1NiJ9",
    "AKIAABCDEFGHIJKLMNOP",
    "account-key-secret",
    "sas-signature-secret",
    "dsn-password-secret",
    "labeled-password-secret",
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "example.com",
  ])
    assert.equal(detail.includes(secret), false, secret);
  assert.ok(detail.length <= 500);
});

test("failure text leaves benign wording unchanged", () => {
  for (const benign of [
    "signature mismatch in design=modern; apikeys rotated; the azure.com docs; risk-assessment",
    "task-runner disk-usage ask-me",
    "status code: 429",
    "code=context_length_exceeded",
    "Basic validation failed",
    "read the docs on platform.openai.com before retrying",
    "token: 4096 exceeds limit",
    "max_tokens=4096",
    "token_type=Bearer",
    "tokenizer=cl100k",
  ])
    assert.equal(failureDetailText(benign), benign);
});

test("failure text matches the shared probe corpus", () => {
  for (const item of failureDetailProbes.cases)
    assert.equal(failureDetailText(item.input), item.output);
});

test("failure text finishes on a long unspaced input", () => {
  const input = `api_key=early-secret ${"a.".repeat(100_000)}`;
  const started = performance.now();
  const detail = failureDetailText(input);
  assert.ok(performance.now() - started < 1000);
  assert.equal(detail.includes("early-secret"), false);
});

test("failure text finishes on a long scheme-like input", () => {
  for (const input of ["a://".repeat(8192), "https://a:".repeat(3276)]) {
    const started = performance.now();
    failureDetailText(input);
    assert.ok(performance.now() - started < 1000);
  }
});

test("a chained cause is sanitized on the failed tick", async () => {
  const x = setup();
  const secret = "cause-host.openai.azure.com";
  x.workflow.propose = async () => {
    throw new Error("outer", { cause: new Error(`see ${secret} sk-causesecretvalue99`) });
  };
  const controller = x.controller();
  const result = await controller.tick("classification");
  assert.equal(result.state, "failed");
  const rendered = JSON.stringify(result);
  assert.match(result.detail ?? "", /outer/);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes("sk-causesecretvalue99"), false);
});

test("a sanitizer failure records a fixed message and not the raw text", async () => {
  const x = setup();
  const secret = "should-not-leak-secret";
  const error = new Error("prefix");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error(secret);
    },
  });
  x.workflow.propose = async () => {
    throw error;
  };
  const controller = x.controller();
  const result = await controller.tick("classification");
  assert.equal(result.state, "failed");
  assert.equal(result.detail, "[detail unavailable]");
  assert.equal(JSON.stringify(result).includes(secret), false);
  const stored = (await controller.getRun(result.runId!))?.data.detail;
  assert.equal(stored, "[detail unavailable]");
});

test("a promoted run consumes feedback and a cap stops before a model call", async () => {
  const x = setup();
  const answerId = servedAnswerId({ namespace: "test", answer: "billing" });
  const saved = await x.loop.recordFeedback({
    answerId,
    rating: { kind: "thumbs", value: "up" },
  });
  let result = await x.controller().tick("classification");
  for (
    let i = 0;
    i < 8 &&
    !["completed", "no_improvement", "rolled_back"].includes(result.state);
    i++
  ) {
    if (result.state === "observing") x.advance();
    result = await x.controller().tick("classification");
  }
  assert.equal(result.state, "completed");
  const cursor = await x.loop.store.transaction("test", (tx) =>
    tx.get("coordination", "feedback-cursor"),
  );
  assert.equal(cursor?.data.position, saved.id);
  assert.equal(cursor?.data.promotionId, result.runId);

  const capped = setup();
  capped.workflow.policy.caps = { runsPerDay: 0, monthlyBudget: 1, callCost: 1 };
  let calls = 0;
  capped.workflow.propose = async () => {
    calls += 1;
    return [{ score: 1 }];
  };
  const idle = await capped.controller().tick("classification");
  assert.equal(idle.reason, "daily_run_cap");
  assert.equal(calls, 0);
  assert.equal(idle.runId, null);

  const month = setup();
  month.workflow.policy.caps = { monthlyBudget: 0, callCost: 1 };
  month.workflow.propose = async () => [{ score: 1 }];
  assert.equal((await month.controller().tick("classification")).reason, "budget_cap");

  const watching = setup();
  watching.workflow.policy.caps = { runsPerDay: 0, monthlyBudget: 0, callCost: 1 };
  const seen = await new ImprovementController(watching.loop, {
    workflows: [watching.workflow],
    mode: "observe",
    selfImproving: true,
  }).tick("classification");
  assert.equal(seen.reason, "observation_only");
});
