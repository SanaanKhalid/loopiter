# Mock support application integration lab

Run from the repository root with Node.js 22 or 24 and a **disposable** PostgreSQL 16/17 database:

```sh
export LOOPITER_TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/loopiter_test'
npm ci
npm run test:mock-support
```

Optionally set `LOOPITER_MOCK_REPORT` to a new report filename. Existing reports are never overwritten.
The lab explicitly applies SDK/application migrations to that database. It removes only its own
random namespaces and artifact scopes afterward; schema tables remain. No Azure key is needed.

## What is exercised

`scripts/mock-support.mjs` starts a localhost HTTP support service and an application-owned worker.
Every scheduler invocation is a new OS process, backed by PostgreSQL. Two workers also race.
The service captures ticket predictions with the actual deployed router version and accepts
authenticated reviewer corrections. Replayed corrections are insert-idempotent; conflicting
ticket IDs are rejected. Contradictory labels quarantine an episode.

The dataset adapter reads captured execution/signal records—not fabricated evaluation metrics.
Optimization, validation and audit sets have distinct episodes/entities and simulated time periods.
The optimizer derives queue mappings from optimization corrections only. The evaluator classifies
the held-out ticket text and computes exact-match scores and per-class gates. A worse second
proposal must not displace the winner. Only the explicitly permitted routing fields can change.

The controller deploys to the same PostgreSQL registry that HTTP prediction requests read.
An injected lost response after external apply requires inspection; the durable receipt count
asserts that the change was not repeated. Subsequent HTTP requests and delayed corrections feed
version-attributed observation, rather than an observer that simply returns a success score.

Four asserted outcomes:

- **Retain:** improve the mapping, wait for mature feedback, complete observation, serve the winner.
- **Regress:** inject a changed ground-truth queue policy after deployment, detect errors, restore
  the predecessor, and verify HTTP requests use the restored artifact.
- **Reject:** optimization labels support no valid improvement; retain the original mapping and
  avoid repeating callbacks for unchanged evidence.
- **Timeout:** no production labels arrive; missing evidence never becomes success, and the
  configured observation timeout restores the predecessor.

Also checks empty evidence, the disabled flag, unauthorized correction requests, duplicated
webhooks, namespace-scoped storage, process restarts, and competing scheduler invocations.
CI runs this lab in each Node/PostgreSQL matrix cell.

## Evidence limits

This is **not a production application template or a live LLM benchmark**. The HTTP server,
PostgreSQL transactions, SDK, worker processes, and serving-version changes are real. Ticket
text, reviewer labels, keyword model, optimizer, and clock are simulated. Repeated text templates
are correlated; the audit-bound arithmetic is not calibrated evidence of real-world accuracy.
The random bearer token is local lab authentication, not a production identity system.
No model requests are made, and no actual provider cost is measured. Controlled label drift tests
rollback mechanics, not a discovered real customer regression.

This lab exercises Node application integration; existing shared fixtures and Python tests cover
Python parity. It is not evidence of a Python HTTP application's behavior, traffic canaries,
real production observation, high throughput, or safety of arbitrary customer adapters.
See the separate retained Azure report for actual model-backed evidence.
