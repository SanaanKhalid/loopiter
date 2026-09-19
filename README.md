# Loopiter

## 0.3 opt-in autonomous alpha

Release versions: `loopiter@0.3.0-alpha.1` and Python `loopiter==0.3.0a1`.
It adds opt-in, policy-bounded `ImprovementController` APIs in both languages, durable
experiments, single-winner selection, production observation and recovery. Default
behavior remains recommendations. Installation never enables autonomous production changes.

See [autonomy guide source](fern/pages/autonomous.mdx), [migration](docs/autonomy-migration.md),
[simulation workflows](examples/autonomous/README.md), and the
[release gates](docs/autonomy-release-checklist.md), and [mock support integration results](reports/mock-support-summary.md).

The [isolated Azure live demonstration](reports/autonomy-live-azure-summary.md) now records
one completed Node cycle and receipt recovery with live calls and synthetic labels—not
production customer-impact evidence. The earlier no-change result is retained too.

A lightweight SDK for **reviewed, evidence-driven AI improvements**, with
Node.js/TypeScript and native Python alphas.
Capture executions and feedback, find recurring scored segments, evaluate an
immutable candidate, approve it, and coordinate deployment or rollback through
your infrastructure. Loopiter is a library, not a hosted service or autonomous trainer.

Published alpha: **0.3.0-alpha.1**, MIT, ESM, Node.js **22 and 24**. No core runtime
dependencies, telemetry, database driver, scheduler, model client, or background daemon.
Loopiter is the new name of Feloop. Install with
`npm install loopiter@0.3.0-alpha.1` or follow the alpha channel with `npm install loopiter@alpha`.

[Canonical documentation](https://loopiter.docs.buildwithfern.com/get-started/overview)
· [Starter](examples/prompt-improvement/README.md)
· [Capabilities](SUPPORTED.md) · [Migration](docs/migration.md)
· [Release gates](docs/release-checklist.md) · [Security](SECURITY.md)

## Python alpha

Python 3.11+ now has a native async SDK in [`python/`](python/README.md): capture,
structured analysis, evaluation, explicit approval, deployment, rollback, recovery,
and optional PostgreSQL. The core has no runtime dependencies and requires no Node.js.

Install with `python -m pip install 'loopiter==0.3.0a1'`, or
`python -m pip install 'loopiter[postgres]==0.3.0a1'` for PostgreSQL support.
From a repository checkout, run `python python/examples/reviewed_loop.py`.
See the [Python guide](python/README.md) for setup and language boundaries.
The 0.3 Python alpha includes the native controller and optional application-side provider examples;
database records/locks remain deliberately separate from Node's.

## Try the source and starter

```sh
git clone https://github.com/SanaanKhalid/loopiter.git loopiter
cd loopiter
npm ci
npm test
npm run starter -- demo
npm run starter -- demo --reject
```

The repository is public. Both demos are **simulated fixtures, not live LLM results**. The accepting demo explicitly
approves its fixture candidate; ordinary recommendations never do that automatically.

The npm package contains the SDK and migrations. Clone the repository above to run
the standalone starter; its provider-specific code is outside the core package.

## Capture a local example

```typescript
import { FeedbackLoop, InMemoryStore } from 'loopiter';

const loop = new FeedbackLoop({
  store: new InMemoryStore(), // Development only; use a conforming DB adapter in production.
  namespace: 'support/development',
});
const execution = await loop.recordExecution({
  id: 'request-123', kind: 'prediction', episodeId: 'ticket-123',
  input: { text: 'Please explain this charge.' }, output: { label: 'other' },
  artifacts: { model: 'your-model-version', prompt: 'intent-v1' },
  metadata: { task: 'support-intent' },
});
await loop.recordSignal({
  id: 'review-123', executionId: execution.id, kind: 'correction',
  name: 'verified_correct', value: false, correction: { label: 'billing' },
  source: 'authorized-reviewer', confidence: 1,
});
await loop.close();
```

Creation is insert-only. Same caller ID and identical normalized/sanitized input
returns the original record; conflicting content fails. Updates require a revision.
A namespace is an integrity scope, **not authentication**. Your application chooses
authorized namespaces and verifies correction sources.

## Bring your own PostgreSQL

Install `pg` in your application. `loopiter/postgres` accepts your pool without importing
the driver. Construction does not create tables. Review and apply the versioned SQL
in `migrations/001-feedback-store.sql`, or explicitly call `migratePostgres(pool)`
with a migration identity. Production request credentials should not need DDL rights.

```typescript
import { Pool } from 'pg';
import { FeedbackLoop } from 'loopiter';
import { PostgresStore, migratePostgres } from 'loopiter/postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL explicitly.');
const pool = new Pool({ connectionString });
await migratePostgres(pool); // Explicit setup, not a constructor side effect.
const loop = new FeedbackLoop({ store: new PostgresStore(pool), namespace: 'support/dev' });
await loop.recordExecution({ kind: 'prediction', input: { text: 'Synthetic setup check' } });
await loop.close(); // Does not close your pool.
await pool.end();
```

Use TLS and your database's credential-management policy. Neither migrations nor
SDK namespaces replace database authorization, encryption, backups, or restore drills.

## Reliability boundary

Evaluation and approval reference exact content, evidence and evaluator versions.
Deployment reserves the target and saves an attempt **before** calling your adapter.
The external call runs outside the database transaction. A valid receipt, candidate
states, lifecycle event and active pointer are finalized atomically afterward.
An uncertain result remains pending until inspection resolves it. Do not retry apply
blindly. An adapter must implement idempotent apply, durable inspect, fenced
`not_applied`, and real rollback. There is no universal exactly-once guarantee.

Default automation only recommends. Experimental auto-apply needs explicit opt-in,
allowed targets, passing metric gates and low-risk prompt/routing changes. Callbacks
run in your process; cancellation is cooperative, **not a sandbox**.

The complete PostgreSQL/OpenAI or Azure OpenAI starter includes real prompt selection, exact-match
holdout evaluation, review, rollback and recovery. Live mode is opt-in, requires
your model/provider credentials/database, sends data to the selected provider and may incur charges. Its small
synthetic dataset is a mechanics demonstration, not evidence of production ROI.
