# Loopiter 0.3 autonomous-layer validation

Validation date: **2026-09-19 (UTC)**. Local working tree based on commit `a3ec752`.
Prepared versions: Node `0.3.0-alpha.1`, Python `0.3.0a1`.
This report records executed local checks, not a remote CI run or publication.

## Status

Implementation and local offline gates pass. The subsequent user-authorized
[Azure live demonstration](autonomy-live-azure-summary.md) now records the isolated Node
end-to-end gate; it uses synthetic labels, not customer evidence. Publication remains separate.
No model calls were made during the initial offline checks below. No package uploads,
documentation publication, website deployment or production enablement were performed.
Neither SDK core adds runtime dependencies or
telemetry. Scientific/provider integrations remain application-side.

## Executed runtime/database matrix

The entire SDK suite ran for every cell below, including adapter conformance,
independent-process PostgreSQL contention, controller restart and deployment recovery.
Databases: PostgreSQL **16.15** and **17.11** in local Docker containers.

| Runtime | PostgreSQL 16 | PostgreSQL 17 |
| --- | --- | --- |
| Node 22.23.2 | 104 passed, 0 skipped | 104 passed, 0 skipped |
| Node 24.21.0 | 104 passed, 0 skipped | 104 passed, 0 skipped |
| Python 3.11.15 | 64 passed, 2 optional skips | 64 passed, 2 optional skips |
| Python 3.12.13 | 64 passed, 2 optional skips | 64 passed, 2 optional skips |
| Python 3.13.9 | 66 passed, 0 skipped | 66 passed, 0 skipped |
| Python 3.14.6 | 64 passed, 2 optional skips | 64 passed, 2 optional skips |

The two optional Python tests require scikit-learn. They ran on 3.13: one rejects
changed classifier weights; one executes all five threshold-workflow paths using an
actual fitted `LogisticRegression` whose weights remain unchanged. Training is synthetic
application setup before the cycle, not an autonomous SDK operation.

Reproduction: build the Node checkout, set the appropriate disposable
`LOOPITER_TEST_DATABASE_URL` or `LOOPITER_PYTHON_TEST_DATABASE_URL`, and run:

```sh
npm run build
node --test dist/test/*.test.js
python -m unittest discover -s python/tests -v
```

The checked-in CI matrix retains the same supported runtime/database combinations.
No live calls are enabled in ordinary CI.

## Behavior and failure boundaries exercised

- Explicit opt-in, exact target/schema policy, obsolete authorization rejection,
  callback/candidate ceilings, durable request/token reservations and unknown usage.
- Frozen baseline/configuration binding, one winning candidate, unchanged-evidence
  deduplication, stale leases, concurrent ticks, cancellation and late callbacks.
- Trusted label eligibility, contradictory-correction quarantine, episode/entity
  independence, delayed outcomes, disjoint partitions and one-time audit consumption.
- Exact audit evaluation binding, including unrelated human evaluations and an
  evaluation change immediately before autonomous approval.
- Immediate observation, missing telemetry, timeouts, regression rollback, receipt loss,
  inspect-only reconciliation, target locking and out-of-band configuration changes.
- Reviewed rollback can recover an autonomous target; separate manual deployment cannot
  bypass its unresolved-cycle lock.
- Canary assignment stability and mocked promotion/inspection/withdrawal failure paths.
  These are adapter-contract tests, **not a deployed traffic-routing experiment**.
- Eight shared language-neutral lifecycle scenarios; all three workflow examples have
  accepted, rejected, insufficient-evidence, interrupted and regressing-after-deployment paths.
- Article-inspired failure memory and consecutive-failure stop; administrative resume
  does not erase reservations, used evidence or unresolved external operations.

These tests are regression evidence, not proof that all races or external failures are
impossible. Application callbacks and adapters remain trusted code, not a sandbox.

## Retained execution reports

- [Node offline matrix](autonomy-offline-node24.json): 15 measured simulated paths.
- [Python offline matrix](autonomy-offline-python313.json): the same 15 paths plus five
  optional scikit-learn paths, with actual metrics and model fingerprints.

Both reports identify synthetic labels, simulated clocks, isolated in-memory serving
registries, injected receipt loss and injected bad post-deployment predictions.
**Live external model calls: zero.** They are not causal production-improvement evidence.

Generate a new report without overwriting existing evidence:

```sh
node scripts/autonomy-report.mjs reports/new-node-report.json
python scripts/autonomy-report.py reports/new-python-report.json --sklearn
```

The optional provider wrappers follow structured-output/refusal handling guidance and
have mocked request/error tests. Their inclusion does not constitute a successful live run.

## Packaging, documentation and website

- Actual npm tarball installed in clean consumers on Node 22 and 24: imports, TypeScript
  declarations, absent `pg` runtime requirement, migration assets, conformance, safe
  defaults and a complete simulated autonomous cycle passed.
- Python wheel and sdist built and checked with Twine; each installed without dependencies
  in a clean Python 3.13 consumer. Core/conformance/migrations, reviewed recovery and
  simulated autonomous deploy/rollback passed against the installed package, not editable core.
- TypeScript build, Ruff checks/formatting and `git diff --check` passed.
- Eight runnable TypeScript documentation snippets compiled; Python README/Fern examples
  passed the existing syntax/execution/synchronization tests.
- Fern 5.113.1 `check --warnings --local` passed. Canonical Fern **source** was updated;
  the public site has not been republished by this task.
- Existing website typecheck, lint and production build passed on Node 24. Its design and
  hosting configuration were preserved. Vinext emitted its existing route-classification
  informational notice; no website release was performed.
- Root and website `npm audit --audit-level=high`: **zero vulnerabilities reported**.
  An audit result is a time-specific database check, not a security certification.

## Fixed synthetic analysis measurement

Executed `npm run benchmark` under Node 24.21.0 on Darwin/arm64:

| Measurement | Observed value |
| --- | ---: |
| Dataset | `fixed-v1`, synthetic |
| Executions / signals / episodes | 10,000 / 10,000 / 5,000 |
| Findings | 43 |
| Elapsed analysis | 366.723375 ms |
| Heap before / after | 21,181,072 / 81,484,856 bytes |
| RSS after | 291,045,376 bytes |
| Process maximum RSS | 287,296 KiB |

This is one in-memory snapshot, not a general throughput, capacity or peak-analysis-memory
guarantee. It does not measure model latency, production databases or autonomous-cycle cost.

## Subsequent live verification and remaining release actions

After these offline checks, the user authorized Azure CLI testing. The separate
[live report](autonomy-live-azure-summary.md) retains the initial authentication failure,
a correct-baseline/no-change result, and a completed stale-mapping experiment with live
Azure inference, an isolated PostgreSQL deployment, subsequent observation and injected
receipt-loss recovery. None is relabeled as real customer or causal production evidence.

No live success is inferred from the historical baseline-only smoke run or these fixtures;
the new live report is separate evidence and currently covers the Node adapter only.
Publication to npm/PyPI/Fern, website deployment and production enablement remain distinct
actions requiring release authorization after validation.
