// Offline recommendation wiring; no claimed model improvement or deployment.
import { FeedbackLoop, InMemoryStore, SelfImprovementController } from '../src/index.js';
const loop = new FeedbackLoop({
  store: new InMemoryStore(),
  namespace: 'example/dev',
});
for (let i = 0; i < 10; i++) {
  const execution = await loop.recordExecution({
    kind: 'tool',
    metadata: { resource: i < 5 ? 'slow_lookup' : 'fast_lookup' },
  });
  await loop.recordSignal({
    executionId: execution.id,
    kind: 'tool_result',
    name: 'within_budget',
    value: i >= 5,
    source: 'synthetic-fixture',
  });
}
const result = await new SelfImprovementController(loop).run({
  analysis: { dimensions: ['metadata.resource'] },
  policy: { allowedTargets: ['routing'] },
  recipes: [
    {
      name: 'cache-lookup',
      version: '1',
      matches: finding => finding.effectSize < 0,
      propose: () => ({
        target: { kind: 'routing', key: 'lookup' },
        proposedChange: { cacheWithinEpisode: true },
        risk: 'low',
      }),
    },
  ],
});
console.log(JSON.stringify({ simulated: true, ...result }, null, 2));
