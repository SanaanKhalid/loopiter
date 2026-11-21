# Loopiter SDKs

This repository contains the standalone TypeScript/Node.js SDK and native Python library.
Neither requires a Loopiter platform account, API key, network connection, or hosted service.
You provide storage, model/evaluation callbacks, scheduling, and deployment integration.

The optional console, REST API, MCP server, knowledge integrations and managed workers
live in the separate `loopiter-platform` repository (local sibling `../loopiter-platform`).
Its HTTP client calls the platform; it is distinct from these standalone libraries.
The marketing website and SDK documentation remain here.

## Optional framework integrations

Capture serving calls with `loopiter/integrations/openai` (OpenAI Node 6/7),
`loopiter/integrations/ai-sdk` (Vercel AI SDK 5/6/7), or
`loopiter.integrations.openai.with_loopiter` (async OpenAI Python 2.x).
The wrappers retain per-call artifact identity, isolate shared clients, replace
released guidance and capture streaming completion/cancellation. Feedback remains
explicit. Core imports have no provider dependencies.
See [integration examples and limits](fern/pages/framework-integrations.mdx) and
[Supermemory attribution](THIRD_PARTY_NOTICES.md). Run `npm run test:integrations`
for packed-consumer compatibility checks using mock providers.

## Set up with your coding agent

The self-hosted onboarding build includes [AGENT_GUIDE.md](AGENT_GUIDE.md), runnable
reference workflows, offline verification and an optional foreground worker. After
installing that build in your application:

```sh
# Python
python -m loopiter init --directory loopiter
python -m loopiter verify

# Node.js
npx --no-install loopiter init --directory loopiter
npx --no-install loopiter verify
```

Give your coding agent this prompt:

> Read loopiter/AGENT_GUIDE.md and complete the self-hosted SDK integration in this
> project. Inspect the application, recommend where to collect feedback, configure
> evaluation and budgets, connect our own storage and model providers, verify the
> integration, and explain how to run, pause and roll it back.

The guide covers existing and new applications, verified feedback, optional Jev
judging, durable storage, real serving attribution, and recovery. A fresh plan is
schemaVersion 2 (`autonomous-default`): mode `autonomous` and self-improving on,
and it still starts incomplete. `doctor` checks declared configuration; `verify`
tests isolated simulated SDK mechanics. Your agent must still verify the real
application. After both succeed, the emitted worker recipe omits `--mode`, so
`plan.mode` controls that command, and the worker runs without `--enable`.
These defaults are unreleased, on main. They are not in the published
`loopiter@0.3.0-alpha.1` or `loopiter==0.3.0a1` packages. `--mode recommend`
stores proposals and does not apply. `--mode observe` inspects evidence and does
not propose. Omitting `--mode` follows
`plan.mode`, or autonomous when no plan is present. Constructing
`ImprovementController` without a mode is autonomous with self-improving on.
Existing schemaVersion 1 plans are left unchanged. Users who never set a mode
previously stayed on recommend: pass `mode: "recommend"` (Python `mode="recommend"`)
or set `plan.mode` to `recommend` to store proposals without applying them.
Set mode or `plan.mode` to `observe` to inspect evidence without proposing.
`--disable`, or `LOOPITER_DISABLE` set to any non-empty value except `0`, `false`,
`no`, or `off` (trimmed and case-insensitive), pauses the worker. `enable` and
`enabled` also pause, and the worker warns because those words look like the
opposite. That pause stops with `self_improvement_disabled` before the
application module is imported, stores no proposal, and does not observe or roll
back a canary that is already running. It is not mode recommend. To stop new
work while observation and recovery continue, call `pause(workflowId, reason)`
(Python: `pause(workflow_id, reason)`). To restore a candidate that is still
serving, call rollback on the deployment adapter. `--enable`, `--confirm-activation`, and
`--yes` are ignored and log a deprecation warning. Validation, audit, budgets,
and rollback are unchanged. No platform login or Loopiter project key is
involved; you pay your own model/judge, database and hosting providers.

Read the guide with `python -m loopiter guide` or `npx --no-install loopiter guide`.
Use `reference` for packaged source. New commands require this onboarding build;
publishing a new npm/PyPI release is separate.

## Published 0.3.0 alpha

Release versions: `loopiter@0.3.0-alpha.1` and Python `loopiter==0.3.0a1`.
It adds policy-bounded `ImprovementController` APIs in both languages, durable
experiments, single-winner selection, production observation and recovery.
Constructing the controller without a mode in 0.3.0-alpha.1 still recommends and does not apply.
A fresh self-hosted init in this repository records autonomous mode and
self-improving on, but that init and worker postdate these published archives.
The published worker follows `plan.mode` unless `--mode` is set, spends only
with `--enable`, and every audit, budget, and rollback gate remains.
Installation never starts a worker or spends by itself. The autonomous default
and the removal of `--enable` are unreleased, on main.

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
· [Capabilities](SUPPORTED.md) · [Pack versus published alpha](docs/capability-matrix.md) · [Migration](docs/migration.md)
· [Release gates](docs/autonomy-release-checklist.md) · [Security](SECURITY.md)

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

The npm package contains the SDK, migrations, agent guide and optional starter
references. `npx --no-install loopiter starter demo` runs the packaged classification
fixture without a checkout or credentials. Its live PostgreSQL path requires the
application to install `pg` and explicitly select `--live`; provider code stays
outside the default core import.

## Offline improvement benchmark

`npm run benchmark:offline` compares a frozen baseline with the autonomous
controller on a synthetic knowledge-base task. It uses seeded mocks only.
See [benchmarks/README.md](benchmarks/README.md).

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

## Acceptance gate

The product default, including onboarding, keeps the fixed `minimumImprovement` margin. Set `objective.acceptance` to `confidence` to use a paired bootstrap lower bound on (candidate − incumbent) instead. The default confidence is 0.90, items are sorted by id, and the seed is fixed. A confidence check with fewer decisive items than `minimumValidationDecisive` or `minimumAuditDecisive` is `insufficient`: it does not deploy, the incumbent keeps serving, and the controller waits for more evidence instead of counting a rejection. The default minimum is 5 at confidence 0.90, the smallest unanimous decisive count whose one-sided sign-test tail falls under the interval tail. A confidence policy cannot set a lower decisive minimum, and its validation and audit unit counts must be at least that same floor. Fixed-margin policies do not use this rule.

An optional `noiseFloor` (`noise_floor` in Python) re-scores the incumbent on validation, audit, or both. It is off when omitted, and only a confidence policy may set it. The second score uses the same scorer and settings, so incumbent scoring on that split is doubled. The paired bootstrap of the two incumbent runs, with the gate's confidence and fixed seed and with items sorted by id, is an upper bound on the absolute effect of two identical runs. The candidate's lower bound must clear the larger of `minimumEffect` and that bound. The decision records the bound, the method, the item count, the extra scoring calls, which threshold was binding, and the effective threshold. A check that did not measure noise records null and `not_measured`, not 0. `explain` prints those fields. The public benchmark harness does not enable this floor yet. The `explain` command's text escapes every character outside printable ASCII, including DEL, and its `--json` output is ASCII-only in both SDKs.

An optional `retention` object (`retention` in Python, with `margin` and optional `confidence`) compares a candidate that would be promoted with the best control score that agent has ever recorded. It is off when omitted, and only a confidence policy may set it. The comparison pairs item scores by id, sorted by UTF-8 bytes, and uses the same fixed-seed paired bootstrap as the acceptance gate. The candidate fails retention when the lower bound of (candidate − best-ever), in the objective direction, is below `-margin`. That failure blocks promotion and is logged as `retention_regression`. Too few decisive overlapping items is `insufficient`, the same not-a-pass outcome as a short confidence sample, and does not deploy. No best-ever record yet, or no shared item ids, is `not_measured` with nulls, never 0. The best-ever record is written in the same save as the move to completed, after observation passes, and only when the shared item ids have a strictly better control mean. No shared ids leaves the record unchanged. Rollback and a failed observation do not write it. The record stays on the controller target's coordination row. `loopiter retention status --file STATE --namespace NAME` and `python -m loopiter retention status --file STATE --namespace NAME` read that row and write nothing. `explain` prints the retention result for each decision. The public benchmark harness does not enable retention, so it makes no extra model calls and its logs leave the field absent.

Read a decision log without calling a model:

```sh
npx --no-install loopiter explain path/to/decisions.json
python -m loopiter explain path/to/decisions.json --json
```

## Eval lock and leakage

`lockEvalSet` (`lock_eval_set` in Python) checksums an eval set. Items are sorted by UTF-8 id, object keys are written in a stable order, and the SHA-256 covers each id, input, and expected output. The lock file records that digest, the item count, and hashing scheme version 1. `verifyEvalLock` / `verify_eval_lock` accepts the same bytes and refuses an added, removed, or edited item. The report is the count of added, removed, and changed ids. It does not include the item contents. Run `eval lock` again to re-lock a suite you intend to change.

`checkEvalLeakage` / `check_eval_leakage` compares a train file with an eval file. An id that appears in both is an overlap. So is a content hash that matches after Unicode NFC and whitespace collapsing. Leading and trailing characters are removed only when they belong to that same whitespace set. The default fields are `input` and `expected`. The report lists up to 20 overlapping ids and the full count. Matching is exact.

```sh
npx --no-install loopiter eval lock suite.json --out suite.lock.json
npx --no-install loopiter eval verify suite.json --lock suite.lock.json
npx --no-install loopiter eval leakage --train train.json --eval suite.json --fields input,expected
python -m loopiter eval verify suite.json --json
```

Verify exits nonzero when the suite drifts. Leakage exits nonzero when any id overlaps. Text escapes every character outside printable ASCII, and `--json` is ASCII-only in both SDKs.

Pass `requireEvalLock: { lock }` (`require_eval_lock={"lock": lock}` in Python) to `ImprovementController` to check the loaded validation and audit rows against that lock after the dataset is read and before a model or evaluator call. Leaving that option unset leaves the check disabled.

## Served answers and feedback

`servedAnswerId` (`served_answer_id` in Python) is a stable id for one answer an agent serves. The canonical inputs are `namespace`, `answer`, and the optional `episodeId` and `artifactVersion`. The encoding is the eval-set lock's canonical JSON: object keys ordered by UTF-8 bytes, and non-ASCII text left as characters. The same inputs produce the same `ans_` id in both SDKs. `recordFeedback` / `record_feedback` stores a rating and/or a corrected edit for that id and target, with an optional note. A numeric rating is from 0 to 1. A thumbs rating is `up` or `down`. Unknown fields, over-long text, and control characters are rejected. Length is counted in Unicode code points. A string of only blank characters, including U+0085, is empty. The same input stored again returns the existing record. Feedback is stored for one target, so two workflows in one namespace do not share it.

The feedback cursor for that target moves, when a candidate is promoted, only to the feedback the run had already seen when it started. Each feedback row gets the next per-target sequence, allocated with the head row's conditional write, and the snapshot and the cursor compare that sequence only. A later write with the same timestamp or an earlier clock stays after the cursor. It returns to its previous position when that promotion is rolled back, in the same transaction as the rollback. A malformed cursor is left untouched, so the rollback receipt is still recorded, and the next promotion fails closed on that row. Optional policy `caps` (`monthlyBudget` and `callCost`, and `runsPerDay`; `monthly_budget`, `call_cost`, and `runs_per_day` in Python) are checked before a model call and are counted per target. A tick that does not call a model does not count as a run. A monthly cap uses UTC months. A daily cap uses UTC days. Reaching a cap returns `budget_cap` or `daily_run_cap` and does not spend. A corrupt counter stops the model call. A revision conflict on a counter pauses the run as `cap_conflict` and does not spend. One `callCost` / `call_cost` charge is one model operation: each propose, and each validation or audit evaluation, including each batch. It is not one charge per run, and it is not one charge per provider request inside a callback. Observation is not charged. A charge is not refunded after it is admitted.

## Reliability boundary

Evaluation and approval reference exact content, evidence and evaluator versions.
Deployment reserves the target and saves an attempt **before** calling your adapter.
The external call runs outside the database transaction. A valid receipt, candidate
states, lifecycle event and active pointer are finalized atomically afterward.
An uncertain result remains pending until inspection resolves it. Do not retry apply
blindly. An adapter must implement idempotent apply, durable inspect, fenced
`not_applied`, and real rollback. There is no universal exactly-once guarantee.

On main, unreleased, constructing the controller without a mode is autonomous
with self-improving on. Mode `recommend` stores proposals and does not apply.
Mode `observe` inspects evidence and does not propose. `--disable`, or
`LOOPITER_DISABLE` set to any non-empty value except `0`, `false`, `no`, or
`off`, pauses before the application module is imported, in
every mode, and stores no proposal. The published `0.3.0-alpha.1` and `0.3.0a1`
packages still recommend
when no mode is set and still spend only with `--enable`. Every policy gate
still applies. The removed experimental auto-apply path stays rejected.
Callbacks run in your process; cancellation is cooperative, **not a sandbox**.

The complete PostgreSQL/OpenAI or Azure OpenAI starter includes real prompt selection, exact-match
holdout evaluation, review, rollback and recovery. Live mode is opt-in, requires
your model/provider credentials/database, sends data to the selected provider and may incur charges. Its small
synthetic dataset is a mechanics demonstration, not evidence of production ROI.

### Application observation and existing telemetry

Use [Application observation](docs/application-observation.md) for `loopiter/integrations/observe`, `loopiter/integrations/otel`, capture privacy, streaming lifecycle and stable trace identity. Reuse the app's OpenTelemetry provider. New observers/exporters default to metadata-only; existing provider wrappers need an explicit capture policy to change their full-capture default. Observational traces do not establish faithful application replay or automatically authorize improvements. Bind customer context on the authenticated server and keep approved replay artifacts separately.
