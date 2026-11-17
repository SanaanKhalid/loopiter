import { performance } from 'node:perf_hooks';
import { FeedbackLoop, InMemoryStore, type AiExecution, type FeedbackSignal } from '../src/index.js';
import { hash } from '../src/utils.js';
const count = 10000,
  namespace = 'benchmark/fixed-v1';
const loop = new FeedbackLoop({ store: new InMemoryStore(), namespace });
const createdAt = '2026-01-01T00:00:00Z';
// Seed in one transaction so this measures analysis, not per-insert dev-store cloning.
await loop.store.transaction(namespace, async tx => {
  for (let i = 0; i < count; i++) {
    const base = { namespace, revision: 1, createdAt, updatedAt: createdAt };
    const execution: AiExecution = {
      ...base,
      id: `e${String(i).padStart(5, '0')}`,
      kind: 'prediction',
      episodeId: `episode${Math.floor(i / 2)}`,
      entityId: `entity${i % 1000}`,
      metadata: { intent: `intent${i % 10}`, region: `region${i % 3}` },
      artifacts: { prompt: 'baseline-v1' },
      startedAt: createdAt,
      inputHash: hash(i),
    };
    const signal: FeedbackSignal = {
      ...base,
      id: `s${String(i).padStart(5, '0')}`,
      executionId: execution.id,
      kind: 'rating',
      name: 'quality',
      source: 'synthetic-benchmark',
      value: i % 10 !== 0,
      confidence: 1,
      metadata: {},
      observedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      inputHash: hash([i, 'signal']),
    };
    await tx.insert('executions', execution);
    await tx.insert('signals', signal);
  }
});
const before = process.memoryUsage(),
  started = performance.now();
const findings = await loop.analyze({
  dimensions: ['metadata.intent', 'metadata.region'],
  maximumDimensionDepth: 2,
  maximumRecords: 20000,
});
const elapsedMs = performance.now() - started,
  after = process.memoryUsage();
console.log(
  JSON.stringify(
    {
      dataset: 'fixed-v1',
      mode: 'synthetic',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      executions: count,
      signals: count,
      episodes: count / 2,
      findings: findings.length,
      elapsedMs,
      heapBeforeBytes: before.heapUsed,
      heapAfterBytes: after.heapUsed,
      rssAfterBytes: after.rss,
      processMaxRssKiB: process.resourceUsage().maxRSS,
      limitation:
        'One in-memory snapshot on a fixed dataset; not a general throughput or peak-analysis-memory guarantee.',
    },
    null,
    2,
  ),
);
await loop.close();
