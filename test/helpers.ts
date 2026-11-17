import { FeedbackLoop, type DeploymentAdapter, type DeploymentReceipt, type DeploymentRequest } from '../src/index.js';
export class Registry implements DeploymentAdapter {
  version: string | null = null;
  applications = 0;
  receipts = new Map<string, DeploymentReceipt>();
  fenced = new Set<string>();
  async apply(request: DeploymentRequest): Promise<DeploymentReceipt> {
    return this.change(request, request.candidate.contentHash);
  }
  async rollback(request: DeploymentRequest): Promise<DeploymentReceipt> {
    return this.change(request, request.attempt.restoreArtifactVersion ?? null);
  }
  private async change(request: DeploymentRequest, version: string | null): Promise<DeploymentReceipt> {
    const previous = this.receipts.get(request.attempt.id);
    if (previous) return previous;
    if (this.fenced.has(request.attempt.id) || this.version !== request.attempt.expectedArtifactVersion)
      throw new Error('Fenced or version conflict.');
    const receipt = {
      attemptId: request.attempt.id,
      artifactVersion: version,
      previousArtifactVersion: this.version,
    };
    this.version = version;
    this.receipts.set(request.attempt.id, receipt);
    this.applications++;
    return receipt;
  }
  async inspect(request: DeploymentRequest) {
    const receipt = this.receipts.get(request.attempt.id);
    if (receipt) return { status: 'applied' as const, receipt };
    this.fenced.add(request.attempt.id);
    return { status: 'not_applied' as const };
  }
}
export async function approved(loop: FeedbackLoop, key: string) {
  const c = await loop.createCandidate({
    id: key,
    target: { kind: 'prompt', key: 'chat' },
    proposedChange: { version: key },
    evidence: {},
    risk: 'low',
  });
  const evaluated = await loop.evaluateCandidate(
    c.id,
    { evaluator: 'test', version: '1', datasetHash: 'fixtures-v1' },
    () => ({ passed: true, metrics: { accuracy: 1 } }),
  );
  return loop.approveCandidate(c.id, {
    actor: 'tester',
    evaluationId: evaluated.evaluations.at(-1)!.id,
  });
}
export async function seed(loop: FeedbackLoop, confidence = 1) {
  for (let i = 0; i < 8; i++) {
    const e = await loop.recordExecution({
      id: `e${i}`,
      kind: 'turn',
      entityId: `user${i}`,
      metadata: { segment: i < 4 ? 'bad' : 'good' },
      startedAt: `2026-01-${String(1 + i * 3).padStart(2, '0')}T00:00:00.000Z`,
    });
    await loop.recordSignal({
      executionId: e.id,
      kind: 'rating',
      name: 'correct',
      source: 'test',
      value: i >= 4,
      confidence,
      observedAt: e.startedAt,
    });
  }
}
export const analysis = {
  dimensions: ['metadata.segment'],
  minimumSupport: 2,
  minimumScoredCount: 2,
  minimumEffectSize: 0.2,
};
