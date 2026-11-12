/** In-memory prompt registry. Development harness only. */
import type {
  DeploymentReceipt,
  DeploymentRequest,
  JsonValue,
} from "../../src/index.js";
import { hash } from "../../src/utils.js";
import type { ArtifactRegistry } from "../../examples/autonomous/workflows.js";

export class PromptRegistry implements ArtifactRegistry {
  version: string;
  private artifacts = new Map<string, JsonValue>();
  private receipts = new Map<string, DeploymentReceipt | null>();
  fingerprint: (artifact: JsonValue) => string = hash;

  constructor(fragment: string) {
    const initial = { fragment };
    this.version = hash(initial);
    this.artifacts.set(this.version, initial);
  }

  /** One-shot arm: install a proposal with no deployment gate. */
  serve(fragment: string): void {
    const artifact = { fragment };
    const version = hash(artifact);
    this.artifacts.set(version, structuredClone(artifact));
    this.version = version;
  }

  fragment(): string {
    return fragmentOf(this.artifacts.get(this.version));
  }

  async current() {
    return { version: this.version, artifact: await this.get(this.version) };
  }

  async get(version: string | null) {
    if (!version || !this.artifacts.has(version))
      throw new Error("Unknown artifact version.");
    return structuredClone(this.artifacts.get(version)!);
  }

  async apply(request: DeploymentRequest) {
    return this.change(request, request.candidate.contentHash, request.candidate.proposedChange);
  }

  async rollback(request: DeploymentRequest) {
    return this.change(
      request,
      request.attempt.restoreArtifactVersion!,
      await this.get(request.attempt.restoreArtifactVersion!),
    );
  }

  async change(request: DeploymentRequest, version: string, artifact: JsonValue) {
    if (this.receipts.has(request.attempt.id)) {
      const prior = this.receipts.get(request.attempt.id);
      if (!prior) throw new Error("Fenced");
      return prior;
    }
    if (this.version !== request.attempt.expectedArtifactVersion)
      throw new Error("Version conflict");
    if (
      request.attempt.operation === "apply" &&
      request.candidate.baseline?.configurationHash !==
        this.fingerprint(this.artifacts.get(this.version)!)
    )
      throw new Error("Configuration conflict");
    const receipt: DeploymentReceipt = {
      attemptId: request.attempt.id,
      artifactVersion: version,
      previousArtifactVersion: this.version,
    };
    this.artifacts.set(version, structuredClone(artifact));
    this.version = version;
    this.receipts.set(request.attempt.id, receipt);
    return receipt;
  }

  async inspect(request: DeploymentRequest) {
    const receipt = this.receipts.get(request.attempt.id);
    if (receipt) return { status: "applied" as const, receipt };
    this.receipts.set(request.attempt.id, null);
    return { status: "not_applied" as const };
  }
}

export function fragmentOf(artifact: JsonValue | undefined): string {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    throw new Error("Prompt artifact must be an object.");
  const fragment = artifact.fragment;
  if (typeof fragment !== "string") throw new Error("Prompt artifact is missing fragment.");
  return fragment;
}
