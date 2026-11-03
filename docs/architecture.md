# Architecture

The canonical maintained architecture is in
[Fern](https://loopiter.docs.buildwithfern.com/get-started/architecture).
The SDK coordinates evidence and transitions. Adapters own persistent transactions
and external side effects. It does not own model training, scheduling or customer auth.

Core source entrypoints: `src/contracts.ts`, `src/store.ts`, `src/feedback-loop.ts`,
`src/analyzer.ts`, `src/self-improvement.ts`. Reference adapters: `src/postgres.ts`
and `examples/prompt-improvement/registry.ts`. Executable adapter guarantees:
`src/testing.ts`; failure/concurrency coverage: `test/`.

For an exploratory extension covering feedback-driven model training alongside
prompt, knowledge, and memory updates, see
[Continuous model improvement](continuous-model-improvement.md). That proposal
describes future work, not current training support.
