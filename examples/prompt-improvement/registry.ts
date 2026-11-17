import { readFile } from 'node:fs/promises';
import type { DeploymentAdapter, DeploymentReceipt, DeploymentRequest } from '../../src/index.js';
import type { PgPoolLike } from '../../src/postgres.js';
import { hash, nonempty } from '../../src/utils.js';
export const baselineFragment =
  'Route login requests to account_access, software faults to technical, and otherwise use other.';
export const baselineVersion = hash(baselineFragment);
export interface PromptRegistry extends DeploymentAdapter {
  current(): Promise<{ version: string; fragment: string }>;
  initialize(): Promise<void>;
}
export function fragmentOf(value: unknown): string {
  const fragment = (value as { fragment?: unknown })?.fragment;
  nonempty(fragment, 'prompt fragment');
  if (fragment.length > 8000 || Object.keys(value as object).some(k => k !== 'fragment'))
    throw new Error('Only a prompt fragment up to 8000 characters is allowed.');
  return fragment;
}
/** Offline-only registry; the live starter uses PostgreSQL below. */
export class MemoryPromptRegistry implements PromptRegistry {
  private version = baselineVersion;
  private prompts = new Map([[baselineVersion, baselineFragment]]);
  private receipts = new Map<string, DeploymentReceipt | null>();
  async initialize() {}
  async current() {
    return { version: this.version, fragment: this.prompts.get(this.version)! };
  }
  async apply(r: DeploymentRequest) {
    return this.change(r, r.candidate.contentHash, fragmentOf(r.candidate.proposedChange));
  }
  async rollback(r: DeploymentRequest) {
    const version = r.attempt.restoreArtifactVersion;
    if (!version || !this.prompts.has(version)) throw new Error('Unknown rollback version.');
    return this.change(r, version, this.prompts.get(version)!);
  }
  private async change(r: DeploymentRequest, version: string, fragment: string) {
    if (this.receipts.has(r.attempt.id)) {
      const receipt = this.receipts.get(r.attempt.id);
      if (!receipt) throw new Error('Attempt fenced.');
      return receipt;
    }
    if (this.version !== r.attempt.expectedArtifactVersion) throw new Error('Prompt version changed.');
    const receipt = {
      attemptId: r.attempt.id,
      artifactVersion: version,
      previousArtifactVersion: this.version,
    };
    this.prompts.set(version, fragment);
    this.version = version;
    this.receipts.set(r.attempt.id, receipt);
    return receipt;
  }
  async inspect(r: DeploymentRequest) {
    const receipt = this.receipts.get(r.attempt.id);
    if (receipt) return { status: 'applied' as const, receipt };
    this.receipts.set(r.attempt.id, null);
    return { status: 'not_applied' as const };
  }
}
export class PostgresPromptRegistry implements PromptRegistry {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly namespace: string,
  ) {
    nonempty(namespace, 'registry namespace');
  }
  async initialize() {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query(
        await readFile(new URL('../../../migrations/starter/001-prompt-registry.sql', import.meta.url), 'utf8'),
      );
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('feloop/starter/schema', 0))");
      await c.query('INSERT INTO feloop_starter_prompts VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        this.namespace,
        baselineVersion,
        baselineFragment,
      ]);
      await c.query('INSERT INTO feloop_starter_active VALUES($1,$2) ON CONFLICT DO NOTHING', [
        this.namespace,
        baselineVersion,
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw e;
    } finally {
      c.release(discard);
    }
  }
  async current() {
    const c = await this.pool.connect();
    let discard = false;
    try {
      const row = (
        await c.query(
          'SELECT a.version,p.fragment FROM feloop_starter_active a JOIN feloop_starter_prompts p ON p.namespace=a.namespace AND p.version=a.version WHERE a.namespace=$1',
          [this.namespace],
        )
      ).rows[0];
      if (!row) throw new Error('Run starter init first.');
      return { version: String(row.version), fragment: String(row.fragment) };
    } finally {
      c.release(discard);
    }
  }
  async apply(r: DeploymentRequest) {
    this.checkRequest(r);
    return this.change(r, false);
  }
  async rollback(r: DeploymentRequest) {
    this.checkRequest(r);
    return this.change(r, true);
  }
  private async change(r: DeploymentRequest, rollback: boolean): Promise<DeploymentReceipt> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`feloop/starter/${this.namespace}`]);
      const prior = (
        await c.query('SELECT receipt FROM feloop_starter_receipts WHERE namespace=$1 AND attempt_id=$2', [
          this.namespace,
          r.attempt.id,
        ])
      ).rows[0];
      if (prior) {
        if (!prior.receipt) throw new Error('Attempt fenced.');
        await c.query('COMMIT');
        return prior.receipt as DeploymentReceipt;
      }
      const row = (
        await c.query('SELECT version FROM feloop_starter_active WHERE namespace=$1 FOR UPDATE', [this.namespace])
      ).rows[0];
      if (!row || row.version !== r.attempt.expectedArtifactVersion) throw new Error('Prompt version changed.');
      const version = rollback ? r.attempt.restoreArtifactVersion : r.candidate.contentHash;
      if (!version) throw new Error('Missing restore version.');
      if (rollback) {
        if (
          !(
            await c.query('SELECT 1 FROM feloop_starter_prompts WHERE namespace=$1 AND version=$2', [
              this.namespace,
              version,
            ])
          ).rowCount
        )
          throw new Error('Unknown rollback version.');
      } else
        await c.query('INSERT INTO feloop_starter_prompts VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
          this.namespace,
          version,
          fragmentOf(r.candidate.proposedChange),
        ]);
      const receipt = {
        attemptId: r.attempt.id,
        artifactVersion: version,
        previousArtifactVersion: String(row.version),
      };
      await c.query('UPDATE feloop_starter_active SET version=$2 WHERE namespace=$1', [this.namespace, version]);
      await c.query('INSERT INTO feloop_starter_receipts VALUES($1,$2,$3)', [
        this.namespace,
        r.attempt.id,
        JSON.stringify(receipt),
      ]);
      await c.query('COMMIT');
      return receipt;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw e;
    } finally {
      c.release(discard);
    }
  }
  async inspect(r: DeploymentRequest) {
    this.checkRequest(r);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`feloop/starter/${this.namespace}`]);
      const row = (
        await c.query('SELECT receipt FROM feloop_starter_receipts WHERE namespace=$1 AND attempt_id=$2', [
          this.namespace,
          r.attempt.id,
        ])
      ).rows[0];
      if (!row) await c.query('INSERT INTO feloop_starter_receipts VALUES($1,$2,NULL)', [this.namespace, r.attempt.id]);
      await c.query('COMMIT');
      return row?.receipt
        ? {
            status: 'applied' as const,
            receipt: row.receipt as DeploymentReceipt,
          }
        : { status: 'not_applied' as const };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw e;
    } finally {
      c.release(discard);
    }
  }
  private checkRequest(r: DeploymentRequest) {
    if (
      r.attempt.namespace !== this.namespace ||
      r.candidate.namespace !== this.namespace ||
      r.attempt.target.kind !== 'prompt' ||
      r.attempt.target.key !== 'support-intent' ||
      r.idempotencyKey !== r.attempt.id
    )
      throw new Error('Prompt registry namespace, target or attempt mismatch.');
  }
}
