/** SIMULATED ONLY: measured deterministic workflows, not live-model improvement evidence. */
import { pathToFileURL } from "node:url";
import {
  FeedbackLoop,
  InMemoryStore,
  ImprovementController,
  type AutonomyPolicy,
  type DatasetSnapshot,
  type DeploymentRequest,
  type DeploymentReceipt,
  type JsonValue,
  type ImprovementWorkflow,
} from "../../src/index.js";
import { hash } from "../../src/utils.js";
import {
  promptWorkflow,
  modelRoutingWorkflow,
  decisionRoutingWorkflow,
  type ArtifactRegistry,
} from "./workflows.js";

class Registry implements ArtifactRegistry {
  version: string;
  private artifacts = new Map<string, JsonValue>();
  private receipts = new Map<string, DeploymentReceipt | null>();
  fingerprint: (artifact: JsonValue) => string = hash;
  constructor(
    initial: JsonValue,
    readonly interrupted = false,
  ) {
    this.version = hash(initial);
    this.artifacts.set(this.version, initial);
  }
  async current() {
    return { version: this.version, artifact: await this.get(this.version) };
  }
  async get(version: string | null) {
    if (!version || !this.artifacts.has(version))
      throw Error("Unknown baseline");
    return structuredClone(this.artifacts.get(version)!);
  }
  async apply(r: DeploymentRequest) {
    const result = await this.change(
      r,
      r.candidate.contentHash,
      r.candidate.proposedChange,
    );
    if (this.interrupted) throw Error("INJECTED lost receipt");
    return result;
  }
  async rollback(r: DeploymentRequest) {
    return this.change(
      r,
      r.attempt.restoreArtifactVersion!,
      await this.get(r.attempt.restoreArtifactVersion!),
    );
  }
  async change(r: DeploymentRequest, version: string, artifact: JsonValue) {
    if (this.receipts.has(r.attempt.id)) {
      const prior = this.receipts.get(r.attempt.id);
      if (!prior) throw Error("Fenced");
      return prior;
    }
    if (this.version !== r.attempt.expectedArtifactVersion)
      throw Error("Version conflict");
    if (
      r.attempt.operation === "apply" &&
      r.candidate.baseline?.configurationHash !==
        this.fingerprint(this.artifacts.get(this.version)!)
    )
      throw Error("Configuration conflict");
    const receipt = {
      attemptId: r.attempt.id,
      artifactVersion: version,
      previousArtifactVersion: this.version,
    };
    this.artifacts.set(version, structuredClone(artifact));
    this.version = version;
    this.receipts.set(r.attempt.id, receipt);
    return receipt;
  }
  async inspect(r: DeploymentRequest) {
    const receipt = this.receipts.get(r.attempt.id);
    if (receipt) return { status: "applied" as const, receipt };
    this.receipts.set(r.attempt.id, null);
    return { status: "not_applied" as const };
  }
}

export type DemoKind = "prompt" | "models" | "decision";
export type DemoPath =
  | "accepted"
  | "rejected"
  | "insufficient"
  | "interrupted"
  | "regression";
/** All numerical thresholds and budgets below are simulation choices, NOT universal safe defaults. */
export async function runDemo(kind: DemoKind, path: DemoPath = "accepted") {
  let now = new Date("2026-05-01T00:00:00.000Z");
  const store = new InMemoryStore(),
    loop = new FeedbackLoop({
      store,
      namespace: `simulated/${kind}/${path}`,
      clock: () => now,
      maximumPayloadBytes: 1048576,
    });
  const initial =
    kind === "prompt"
      ? { fragment: "Default to other." }
      : kind === "models"
        ? { simple: "premium", complex: "premium" }
        : { threshold: 0 };
  const registry = new Registry(initial, path === "interrupted");
  const baseline = registry.version;
  const mkRows = (partition: string, count: number, day: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `export-${partition}-${i}`,
      episodeId: `ticket-${partition}-${i}`,
      entityId: `customer-${partition}-${i}`,
      occurredAt: `2026-04-0${day}T00:00:00.000Z`,
      observedAt: `2026-04-0${day}T01:00:00.000Z`,
      source: "verified-export",
      input: {
        text: i % 2 ? "refund for a charge" : "password reset",
        segment: i % 2 ? "simple" : "complex",
        index: i,
      },
      label: i % 2 ? "billing" : "access",
    }));
  const snapshot: DatasetSnapshot = {
    version: "simulated-customer-export-v1",
    optimization: mkRows("optimization", 10, 1),
    validation: mkRows("validation", 100, 2),
    audit: mkRows("audit", 200, 3),
  };
  if (path === "insufficient") snapshot.audit = [];
  const policy: AutonomyPolicy = {
    version: "simulation-only-v1",
    target: {
      kind: kind === "prompt" ? "prompt" : "routing",
      key: `isolated-${kind}`,
    },
    changeSchema:
      kind === "prompt"
        ? {
            type: "object",
            properties: { fragment: { type: "string", maxLength: 1000 } },
            required: ["fragment"],
            additionalProperties: false,
          }
        : kind === "models"
          ? {
              type: "object",
              properties: {
                simple: { type: "string", enum: ["premium", "economy"] },
                complex: { type: "string", enum: ["premium", "economy"] },
              },
              required: ["simple", "complex"],
              additionalProperties: false,
            }
          : {
              type: "object",
              properties: {
                threshold: { type: "number", enum: [0, 0.8, 0.95] },
              },
              required: ["threshold"],
              additionalProperties: false,
            },
    objective: {
      metric:
        kind === "models"
          ? "cost"
          : kind === "decision"
            ? "utility"
            : "accuracy",
      direction: kind === "models" ? "minimize" : "maximize",
      minimumImprovement: 0.05,
      range: [0, 1],
      alpha: 0.05,
    },
    guardrails:
      kind === "decision"
        ? [
            { metric: "coverage", comparator: "gte", value: 0.3 },
            { metric: "errors", comparator: "lte", value: 0.05 },
          ]
        : [
            { metric: "accuracy", comparator: "gte", value: 0.95 },
            { metric: "latencyMs", comparator: "lte", value: 100 },
          ],
    trustedSources: ["verified-export"],
    minimumNewUnits: 10,
    minimumValidationUnits: 100,
    minimumAuditUnits: 200,
    outcomeMaturityMs: 3600000,
    maximumRows: 1000,
    daily: { modelRequests: 10, tokens: 10000, deployments: 1 },
    callbackReservation: { modelRequests: 3, tokens: 3000 },
    cooldownMs: 3600000,
    rollout: { mode: "immediate" },
    observation: {
      minimumDurationMs: 3600000,
      timeoutMs: 86400000,
      minimumUnits: 20,
      guardrails: [{ metric: "errors", comparator: "lte", value: 0.05 }],
      onTimeout: "rollback",
      onFailure: "rollback",
    },
    onInsufficientEvidence: "wait",
    onUncertainDeployment: "reconcile",
  };
  let workflow: ImprovementWorkflow;
  const common = {
    id: `simulated-${kind}`,
    version: "1",
    policy,
    registry,
    dataset: async () => snapshot,
    observe: async (input: Parameters<ImprovementWorkflow["observe"]>[0]) => {
      // Feed subsequent simulated predictions through the deployed artifact, record trusted outcomes.
      const artifact = (await registry.current()).artifact;
      const rows = mkRows("production", 20, 4),
        unitIds: string[] = [];
      let errors = 0;
      for (const row of rows) {
        const lowConfidence = row.input.index % 5 < 3;
        let predicted =
          kind === "prompt"
            ? String((artifact as { fragment: string }).fragment).includes(
                "Billing",
              )
              ? row.input.text.includes("refund")
                ? "billing"
                : "access"
              : "other"
            : kind === "models"
              ? row.input.text.includes("refund")
                ? "billing"
                : "access"
              : (lowConfidence ? 0.55 : 0.9) <
                  (artifact as { threshold: number }).threshold
                ? "escalated"
                : lowConfidence
                  ? row.label === "billing"
                    ? "access"
                    : "billing"
                  : row.label;
        if (path === "regression") predicted = "wrong";
        const correct = predicted === "escalated" || predicted === row.label;
        errors += Number(!correct);
        unitIds.push(row.entityId);
        const e = await loop.recordExecution({
          id: row.id,
          episodeId: row.episodeId,
          entityId: row.entityId,
          kind: "prediction",
          input: row.input,
          output: predicted,
          artifacts: { version: registry.version },
          startedAt: input.deployedAt,
        });
        await loop.recordSignal({
          id: `outcome-${row.id}`,
          executionId: e.id,
          kind: "outcome",
          name: "correct",
          source: "verified-export",
          value: correct,
          observedAt: now.toISOString(),
        });
      }
      const identity = await workflow.artifact({
        operationId: "simulation-read",
        signal: AbortSignal.abort(),
        meter: async () => {
          throw Error("No models in fixture");
        },
      });
      return {
        artifactVersion: registry.version,
        configurationHash: identity.configurationHash,
        startedAt: input.deployedAt,
        endedAt: now.toISOString(),
        complete: true,
        unitIds,
        metrics: { errors: errors / rows.length },
      };
    },
  };
  if (kind === "prompt")
    workflow = promptWorkflow({
      ...common,
      modelId: "simulated-keyword-classifier",
      labels: ["billing", "access", "other"],
      propose: async (examples) => {
        if (!examples.length) return [];
        return [
          path === "rejected"
            ? "Default to other."
            : "Billing: refund/charge. Access: password.",
        ];
      },
      predict: async ({ fragment, text }) => ({
        label: fragment.includes("Billing")
          ? text.includes("refund")
            ? "billing"
            : "access"
          : "other",
        cost: 0,
        latencyMs: 0,
      }),
    });
  else if (kind === "models")
    workflow = modelRoutingWorkflow({
      ...common,
      models: ["premium", "economy"],
      segments: ["simple", "complex"],
      proposals: [
        path === "rejected"
          ? { simple: "premium", complex: "premium" }
          : { simple: "economy", complex: "economy" },
      ],
      predict: async (model, input) => ({
        label: String((input as { text: string }).text).includes("refund")
          ? "billing"
          : "access",
        cost: model === "economy" ? 0.1 : 1,
        latencyMs: model === "economy" ? 10 : 20,
      }),
    });
  else
    workflow = decisionRoutingWorkflow({
      ...common,
      modelFingerprint: "fixed-weights-and-preprocessing-v1",
      thresholds: path === "rejected" ? [0] : [0, 0.8, 0.95],
      abstentionCost: 0.3,
      labels: ["billing", "access"],
      predict: async (input) => {
        const i = (input as { index: number }).index,
          truth = i % 2 ? "billing" : "access";
        return {
          label:
            i % 5 < 3 ? (truth === "billing" ? "access" : "billing") : truth,
          confidence: i % 5 < 3 ? 0.55 : 0.9,
        };
      },
    });
  // Fencing fingerprint matches the helper's immutable model/safety configuration.
  const fingerprint = (
    await workflow.artifact({
      operationId: "setup",
      signal: new AbortController().signal,
      meter: async () => {
        throw Error("No model");
      },
    })
  ).configurationHash;
  registry.fingerprint = () => fingerprint;
  const controller = () =>
    new ImprovementController(loop, {
      workflows: [workflow],
      mode: "autonomous",
      selfImproving: true,
    });
  const transitions = [];
  let result;
  for (let i = 0; i < 10; i++) {
    result = await controller().tick(workflow.id);
    transitions.push({ state: result.state, reason: result.reason });
    if (
      [
        "completed",
        "no_improvement",
        "rolled_back",
        "waiting_for_evidence",
        "failed",
      ].includes(result.state)
    )
      break;
    if (result.state === "observing") now = new Date(+now + 7200000);
  }
  const run = result?.runId
    ? await controller().getRun(result.runId)
    : undefined;
  return {
    evidence: "SIMULATED / isolated in-memory application",
    kind,
    path,
    transitions,
    result,
    baseline,
    activeVersion: registry.version,
    validation: run?.data.comparisons,
    audit: run?.data.audit,
    observations: (await loop.list("observations")).items.map((r) => r.data),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const kind = process.argv[2] ?? "prompt",
    path = process.argv[3] ?? "accepted";
  if (
    !["prompt", "models", "decision"].includes(kind) ||
    ![
      "accepted",
      "rejected",
      "insufficient",
      "interrupted",
      "regression",
    ].includes(path)
  )
    throw Error(
      "Usage: demo.js prompt|models|decision accepted|rejected|insufficient|interrupted|regression",
    );
  console.log(
    JSON.stringify(await runDemo(kind as DemoKind, path as DemoPath), null, 2),
  );
}
