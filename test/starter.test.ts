import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackLoop, InMemoryStore } from '../src/index.js';
import { PromptStarter, FixtureProvider } from '../examples/prompt-improvement/workflow.js';
import { MemoryPromptRegistry, baselineVersion } from '../examples/prompt-improvement/registry.js';
import { OpenAIProvider, AzureOpenAIProvider, type GenerateInput } from '../examples/prompt-improvement/provider.js';
const request: GenerateInput = {
  instructions: 'Test',
  input: 'fixture',
  name: 'fixture',
  schema: {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false,
  },
  signal: new AbortController().signal,
};
test('offline starter evaluates, requires approval, deploys changed inference and rolls back', async () => {
  const loop = new FeedbackLoop({
      store: new InMemoryStore(),
      namespace: 'starter',
    }),
    registry = new MemoryPromptRegistry();
  const starter = new PromptStarter(loop, new FixtureProvider(), registry),
    signal = new AbortController().signal;
  await starter.seed(signal);
  const proposal = await starter.recommend(signal);
  assert.ok(proposal.candidate);
  const evaluated = await starter.evaluate(proposal.candidate.id, signal);
  assert.equal(evaluated.evaluations[0]!.passed, true);
  await assert.rejects(starter.deploy(evaluated, signal));
  const approved = await starter.approve(evaluated.id, 'human-test');
  await starter.deploy(approved, signal);
  assert.equal((await starter.predict('Explain this receipt amount.', signal)).label, 'billing');
  await loop.rollbackCandidate(approved.id, { adapter: registry });
  assert.equal((await registry.current()).version, baselineVersion);
  assert.equal((await starter.predict('Explain this receipt amount.', signal)).label, 'other');
});
test('offline starter rejects a genuinely worse fixture candidate', async () => {
  const loop = new FeedbackLoop({
      store: new InMemoryStore(),
      namespace: 'starter',
    }),
    registry = new MemoryPromptRegistry();
  const starter = new PromptStarter(loop, new FixtureProvider(true), registry),
    signal = new AbortController().signal;
  await starter.seed(signal);
  const proposed = await starter.recommend(signal);
  assert.ok(proposed.candidate);
  const evaluated = await starter.evaluate(proposed.candidate.id, signal);
  assert.equal(evaluated.evaluations[0]!.passed, false);
  await assert.rejects(starter.approve(evaluated.id, 'human'));
});
test('conflicting verified labels are excluded from proposal examples', async () => {
  const loop = new FeedbackLoop({
      store: new InMemoryStore(),
      namespace: 'starter',
    }),
    registry = new MemoryPromptRegistry(),
    provider = new FixtureProvider();
  const starter = new PromptStarter(loop, provider, registry),
    signal = new AbortController().signal;
  await starter.seed(signal);
  const executions = (await loop.list('executions')).items;
  for (const e of executions.slice(0, 2)) await starter.correct(e.id, 'technical', 'conflicting-reviewer');
  assert.equal((await starter.recommend(signal)).candidate, null);
});
test('OpenAI adapter uses structured outputs, user model, no storage and enforces budgets', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    apiKey: 'synthetic-test-key',
    model: 'configured-test-model',
    maximumRequests: 1,
    fetch: (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'configured-test-model');
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      return Response.json({
        status: 'completed',
        model: 'configured-test-model-snapshot',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"label":"billing"}' }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    }) as typeof fetch,
  });
  const result = await provider.generate(request);
  assert.equal(result.value.label, 'billing');
  assert.equal(result.inputTokens, 4);
  assert.equal(result.model, 'configured-test-model-snapshot');
  await assert.rejects(provider.generate(request), /budget/);
  assert.equal(calls, 1);
});
for (const [name, body] of [
  [
    'refusal',
    {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'test' }] }],
    },
  ],
  ['incomplete', { status: 'incomplete', output: [] }],
  [
    'malformed JSON',
    {
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'not json' }],
        },
      ],
    },
  ],
] as const)
  test(`OpenAI adapter rejects ${name}`, async () => {
    const p = new OpenAIProvider({
      apiKey: 'synthetic-test-key',
      model: 'test',
      fetch: (async () => Response.json(body)) as typeof fetch,
    });
    await assert.rejects(p.generate(request));
  });
test('OpenAI adapter rejects non-success and cancellation without retry', async () => {
  let calls = 0;
  const p = new OpenAIProvider({
    apiKey: 'synthetic-test-key',
    model: 'test',
    fetch: (async () => {
      calls++;
      return new Response('', { status: 429 });
    }) as typeof fetch,
  });
  await assert.rejects(p.generate(request), /429/);
  assert.equal(calls, 1);
  await assert.rejects(p.generate({ ...request, signal: AbortSignal.abort() }));
  assert.equal(calls, 1);
});

test('Azure sends deployment and the selected credential only to its Responses endpoint', async () => {
  for (const auth of ['key', 'token'] as const) {
    let tokenCalls = 0;
    const provider = new AzureOpenAIProvider({
      endpoint: 'https://test-resource.openai.azure.com/',
      model: 'my-deployment',
      ...(auth === 'key'
        ? { apiKey: 'fixture-key' }
        : {
            tokenProvider: async () => {
              tokenCalls++;
              return `fixture-token-${tokenCalls}`;
            },
          }),
      fetch: (async (url, init) => {
        assert.equal(url, 'https://test-resource.openai.azure.com/openai/v1/responses');
        assert.equal(init?.redirect, 'error');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('api-key'), auth === 'key' ? 'fixture-key' : null);
        assert.equal(headers.get('Authorization'), auth === 'token' ? `Bearer fixture-token-${tokenCalls}` : null);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'my-deployment');
        assert.equal(body.store, false);
        assert.equal(body.text.format.strict, true);
        return Response.json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"label":"billing"}' }] }],
        });
      }) as typeof fetch,
    });
    assert.equal((await provider.generate(request)).value.label, 'billing');
    await provider.generate(request);
    assert.equal(tokenCalls, auth === 'token' ? 2 : 0);
  }
});

test('Azure fails closed on unsafe endpoints, ambiguous/missing auth, empty tokens and cancelled auth', async () => {
  const options = { endpoint: 'https://test-resource.openai.azure.com/', model: 'deployment' };
  for (const endpoint of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?key=secret',
  ]) {
    assert.throws(() => new AzureOpenAIProvider({ ...options, endpoint, apiKey: 'fixture' }));
  }
  assert.throws(() => new AzureOpenAIProvider(options));
  assert.throws(() => new AzureOpenAIProvider({ ...options, apiKey: 'fixture', tokenProvider: async () => 'fixture' }));
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw new Error('Unexpected fetch');
  }) as typeof fetch;
  const empty = new AzureOpenAIProvider({ ...options, tokenProvider: async () => '', fetch: fetcher });
  await assert.rejects(empty.generate(request), /token/);
  const controller = new AbortController();
  const cancelled = new AzureOpenAIProvider({
    ...options,
    tokenProvider: async () => {
      controller.abort();
      return 'fixture';
    },
    fetch: fetcher,
  });
  await assert.rejects(cancelled.generate({ ...request, signal: controller.signal }));
  assert.equal(calls, 0);
});
