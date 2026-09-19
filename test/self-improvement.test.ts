import assert from "node:assert/strict";
import test from "node:test";
import {
  FeedbackLoop,
  InMemoryStore,
  SelfImprovementController,
  type SelfImprovementRunInput,
} from "../src/index.js";
import { analysis, seed, Registry, approved } from "./helpers.js";
async function setup() {
  const loop = new FeedbackLoop({
    store: new InMemoryStore(),
    namespace: "test",
  });
  await seed(loop);
  return { loop, controller: new SelfImprovementController(loop) };
}
function input(): SelfImprovementRunInput {
  return {
    analysis,
    policy: { allowedTargets: ["prompt"] },
    recipes: [
      {
        name: "test",
        version: "1",
        matches: (f) => f.effectSize < 0,
        propose: () => ({
          target: { kind: "prompt", key: "chat" },
          proposedChange: { text: "improved" },
          risk: "low",
        }),
      },
    ],
    evaluator: () => ({ passed: true, metrics: { accuracy: 1 } }),
    evaluation: { name: "test", version: "1", datasetHash: "holdout1" },
  };
}
test("review-first is default and evidence/version-aware dedup is idempotent", async () => {
  const { controller, loop } = await setup();
  const a = await controller.run(input()),
    b = await controller.run(input());
  assert.equal(a.autonomy, "recommend");
  assert.equal(a.candidates[0]!.id, b.candidates[0]!.id);
  assert.equal(a.deployed.length, 0);
  const next = input();
  next.evaluation!.version = "2";
  const c = await controller.run(next);
  assert.notEqual(a.candidates[0]!.id, c.candidates[0]!.id);
  assert.equal((await loop.list("candidates")).items.length, 2);
});
test("candidate budget stops expensive proposals before invoking the next recipe", async () => {
  const { controller } = await setup();
  let calls = 0;
  const x = input();
  x.policy.maximumCandidatesPerRun = 1;
  x.recipes[0]!.matches = () => true;
  const old = x.recipes[0]!.propose;
  x.recipes[0]!.propose = (f, c) => {
    calls++;
    return old(f, c);
  };
  const result = await controller.run(x);
  assert.equal(calls, 1);
  assert.equal(result.candidates.length, 1);
});
test("invalid risk and autonomy fail closed without deployment", async () => {
  const { controller } = await setup();
  const x = input();
  x.policy.autonomy = "typo" as never;
  await assert.rejects(controller.run(x));
  const y = input();
  y.recipes[0]!.propose = () => ({
    target: { kind: "prompt", key: "chat" },
    proposedChange: {},
    risk: "LOW" as never,
  });
  const result = await controller.run(y);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.blocked[0]?.reason, "run_failed");
});
test("obsolete auto-apply is rejected even with its former opt-in", async () => {
  const { controller } = await setup();
  const x = input();
  x.policy.autonomy = "apply" as never;
  x.deploymentAdapter = new Registry();
  await assert.rejects(controller.run(x));
  Object.assign(x.policy,{experimentalAutoApply:true});
  x.policy.constraints = [
    { metric: "accuracy", comparator: "gte", value: 0.95 },
  ];
  await assert.rejects(controller.run(x), {code:'migration_required'});
});
test("failed constraints and higher risk never auto-deploy", async () => {
  const { controller } = await setup();
  const x = input();
  Object.assign(x.policy, {
    autonomy: "apply",
    experimentalAutoApply: true,
    allowedTargets: ["prompt"],
    constraints: [{ metric: "missing", comparator: "gte", value: 1 }],
  });
  x.deploymentAdapter = new Registry();
  await assert.rejects(controller.run(x), {code:'migration_required'});
});
test("timeout ignores late proposals", async () => {
  const { controller, loop } = await setup();
  const x = input();
  x.policy.callbackTimeoutMs = 5;
  x.recipes[0]!.propose = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return {
      target: { kind: "prompt", key: "chat" },
      proposedChange: {},
      risk: "low",
    };
  };
  const result = await controller.run(x);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(result.candidates.length, 0);
  assert.equal((await loop.list("candidates")).items.length, 0);
});
test("pre-cancelled run does no work", async () => {
  const { controller } = await setup();
  const x = input();
  x.signal = AbortSignal.abort();
  assert.equal((await controller.run(x)).blocked[0]?.reason, "run_cancelled");
});
test("deployment disable switch blocks apply but permits rollback recovery", async () => {
  let enabled = true;
  const loop = new FeedbackLoop({
      store: new InMemoryStore(),
      namespace: "test",
      deploymentsEnabled: () => enabled,
    }),
    adapter = new Registry();
  await approved(loop, "a");
  await loop.deployCandidate("a", { adapter });
  enabled = false;
  await approved(loop, "b");
  await assert.rejects(loop.deployCandidate("b", { adapter }));
  await loop.rollbackCandidate("a", { adapter });
  assert.equal(adapter.version, null);
});
