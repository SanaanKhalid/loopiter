// Synthetic local feedback capture; no external application is connected.
import { FeedbackLoop, InMemoryStore } from '../src/index.js';
const loop = new FeedbackLoop({
  store: new InMemoryStore(),
  namespace: 'example/dev',
});
const turn = await loop.recordExecution({
  kind: 'turn',
  episodeId: 'synthetic-ticket',
  input: { message: 'Classify this request' },
  artifacts: { prompt: 'example@1' },
});
await loop.recordSignal({
  executionId: turn.id,
  kind: 'correction',
  name: 'correct',
  value: false,
  correction: { intent: 'account_access' },
  source: 'synthetic-operator',
});
console.log(
  JSON.stringify(
    {
      simulated: true,
      execution: turn.id,
      message: 'See the prompt-improvement starter for the complete alpha workflow.',
    },
    null,
    2,
  ),
);
