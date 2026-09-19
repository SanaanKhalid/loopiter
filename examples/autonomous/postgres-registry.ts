/** Application-side immediate-rollout example, not SDK-owned serving infrastructure. */
import { readFile } from "node:fs/promises";
import type { PgPoolLike, PgClientLike } from "../../src/postgres.js";
import type {
  CandidateTarget,
  DeploymentReceipt,
  DeploymentRequest,
  JsonValue,
} from "../../src/index.js";
import { hash, nonempty, fail } from "../../src/utils.js";
import type { ArtifactRegistry } from "./workflows.js";

export async function migrateArtifactRegistry(pool: PgPoolLike) {
  const c = await pool.connect();
  let discard = false;
  try {
    await c.query(
      await readFile(
        new URL("../../../examples/autonomous/registry.sql", import.meta.url),
        "utf8",
      ),
    );
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {
      discard = true;
    });
    throw error;
  } finally {
    c.release(discard);
  }
}
export class PostgresArtifactRegistry implements ArtifactRegistry {
  readonly scope: string;
  constructor(
    readonly pool: PgPoolLike,
    readonly namespace: string,
    readonly target: CandidateTarget,
  ) {
    nonempty(namespace, "namespace");
    nonempty(target.key, "target key");
    this.scope = hash({ namespace, target });
  }
  private async transaction<T>(
    fn: (c: PgClientLike) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query("BEGIN");
      await c.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `loopiter/artifact/${this.scope}`,
      ]);
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      c.release(discard);
    }
  }
  /** Explicit initial seed only. Never overwrite an existing serving artifact. */
  async initialize(artifact: JsonValue, configurationHash: string) {
    nonempty(configurationHash, "configurationHash");
    const version = hash(artifact);
    await this.transaction(async (c) => {
      const prior = (
        await c.query(
          "SELECT version,configuration_hash FROM loopiter_example_targets WHERE scope=$1",
          [this.scope],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.version !== version ||
          prior.configuration_hash !== configurationHash
        )
          fail("conflict", "Registry already initialized differently.");
        return;
      }
      await c.query("INSERT INTO loopiter_example_artifacts VALUES($1,$2,$3)", [
        this.scope,
        version,
        JSON.stringify(artifact),
      ]);
      await c.query("INSERT INTO loopiter_example_targets VALUES($1,$2,$3)", [
        this.scope,
        version,
        configurationHash,
      ]);
    });
  }
  async current() {
    return this.transaction(async (c) => {
      const r = (
        await c.query(
          "SELECT t.version,t.configuration_hash,a.artifact FROM loopiter_example_targets t JOIN loopiter_example_artifacts a USING(scope,version) WHERE scope=$1",
          [this.scope],
        )
      ).rows[0];
      if (!r)
        fail(
          "not_found",
          "Explicitly initialize the application registry first.",
        );
      return {
        version: String(r.version),
        configurationHash: String(r.configuration_hash),
        artifact: r.artifact as JsonValue,
      };
    });
  }
  async get(version: string | null) {
    return this.transaction(async (c) => {
      const r = (
        await c.query(
          "SELECT artifact FROM loopiter_example_artifacts WHERE scope=$1 AND version=$2",
          [this.scope, version],
        )
      ).rows[0];
      if (!r) fail("not_found", "Unknown artifact version.");
      return r.artifact as JsonValue;
    });
  }
  private request(r: DeploymentRequest) {
    if (
      r.candidate.namespace !== this.namespace ||
      hash(r.candidate.target) !== hash(this.target)
    )
      fail("forbidden_target", "Registry namespace/target mismatch.");
    if (!r.candidate.baseline)
      fail(
        "invalid_input",
        "Autonomous registry requires a baseline-bound candidate.",
      );
    return hash({
      id: r.attempt.id,
      operation: r.attempt.operation,
      expected: r.attempt.expectedArtifactVersion,
      restore: r.attempt.restoreArtifactVersion ?? null,
      candidate: r.candidate.contentHash,
      configuration: r.candidate.baseline.configurationHash,
    });
  }
  async apply(r: DeploymentRequest) {
    return this.change(r, false);
  }
  async rollback(r: DeploymentRequest) {
    return this.change(r, true);
  }
  private async change(
    r: DeploymentRequest,
    rollback: boolean,
  ): Promise<DeploymentReceipt> {
    const requestHash = this.request(r);
    return this.transaction(async (c) => {
      const prior = (
        await c.query(
          "SELECT request_hash,receipt FROM loopiter_example_receipts WHERE scope=$1 AND attempt_id=$2",
          [this.scope, r.attempt.id],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail("conflict", "Idempotency key reused with different request.");
        if (!prior.receipt) fail("fenced", "Inspection fenced this operation.");
        return prior.receipt as DeploymentReceipt;
      }
      const active = (
        await c.query(
          "SELECT version,configuration_hash FROM loopiter_example_targets WHERE scope=$1 FOR UPDATE",
          [this.scope],
        )
      ).rows[0];
      if (
        !active ||
        active.version !== r.attempt.expectedArtifactVersion ||
        active.configuration_hash !== r.candidate.baseline!.configurationHash
      )
        fail("stale_baseline", "Serving artifact/model context changed.");
      const version = rollback
        ? r.attempt.restoreArtifactVersion
        : r.candidate.contentHash;
      if (!version) fail("not_found", "Missing predecessor.");
      if (rollback) {
        if (
          !(
            await c.query(
              "SELECT 1 FROM loopiter_example_artifacts WHERE scope=$1 AND version=$2",
              [this.scope, version],
            )
          ).rowCount
        )
          fail("not_found", "Unknown predecessor.");
      } else
        await c.query(
          "INSERT INTO loopiter_example_artifacts VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [this.scope, version, JSON.stringify(r.candidate.proposedChange)],
        );
      const receipt = {
        attemptId: r.attempt.id,
        artifactVersion: version,
        previousArtifactVersion: String(active.version),
      };
      await c.query(
        "UPDATE loopiter_example_targets SET version=$2 WHERE scope=$1",
        [this.scope, version],
      );
      await c.query(
        "INSERT INTO loopiter_example_receipts VALUES($1,$2,$3,$4)",
        [this.scope, r.attempt.id, requestHash, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }
  async inspect(r: DeploymentRequest) {
    const requestHash = this.request(r);
    return this.transaction(async (c) => {
      const prior = (
        await c.query(
          "SELECT request_hash,receipt FROM loopiter_example_receipts WHERE scope=$1 AND attempt_id=$2",
          [this.scope, r.attempt.id],
        )
      ).rows[0];
      if (prior?.request_hash && prior.request_hash !== requestHash)
        fail("conflict", "Inspection request mismatch.");
      if (prior?.receipt)
        return {
          status: "applied" as const,
          receipt: prior.receipt as DeploymentReceipt,
        };
      if (!prior)
        await c.query(
          "INSERT INTO loopiter_example_receipts VALUES($1,$2,$3,NULL)",
          [this.scope, r.attempt.id, requestHash],
        );
      return { status: "not_applied" as const };
    });
  }
}
