# Changelog

## Unreleased

### Minor

- The live KB-QA harness retries only the listed transient socket failures, bounds each attempt with a deadline, and exits if the run goes quiet. The retry-wait cap is per call and does not include pace waits. A partial report keeps finished per-seed scores. Pacing still uses 90% of `LOOPITER_BENCH_MAX_TPM`.
- Controller step and tick deadlines can be raised up to one hour. The tick deadline covers the step. The live KB-QA harness sets that step from the calls in one callback, the request attempts, and the retry waits, bounded by the total-wait cap.
- Fresh self-hosted `init` writes onboarding plan schemaVersion 2, preset `autonomous-default`, in Node and Python: `mode` autonomous and self-improving on. Doctor still accepts schemaVersion 1 plans and does not rewrite them.
- `ImprovementController` constructed without a mode still recommends and does not apply. The worker still requires `--enable` before spending. New setup recipes pass `--enable --mode autonomous` after doctor and verify. `--mode recommend` remains one flag away, and omitting `--mode` still selects recommend.
- `--enable` authorizes improvement work and provider spending inside the existing gates. Autonomous mode still fails closed without an audit partition, a budget, or that flag. Validation, audit, minimum improvement, guardrails, trusted sources, budgets, cooldown, the consecutive-failure stop, canary promotion, observation rollback, pause, and lease checks are unchanged. No storage migration.
- Before the first `--enable --mode autonomous` run, the agent guide and init recipe require one-time explicit confirmation from the human. A checklist, doctor report, or plan output is not that confirmation. Later autonomous runs do not add per-candidate approval.

- Package a self-hosted agent guide and application-side references with both SDKs.
- Add initialization, configuration inspection, isolated offline verification and explicit foreground worker commands in native Python and Node.
- Document application-owned feedback verification, storage, evaluator selection (including optional Jev), provider budgets, autonomous activation and recovery.
- Keep the core dependency-free and platform-independent; initialization enables no spending or releases. npm/PyPI publication is separate.

## 0.3.0-alpha.1 / Python 0.3.0a1 — 2026-09-19

- Add opt-in autonomous controllers with exact-target policies and namespace-scoped durable runs.
- Bind candidates to baseline artifacts/configuration; select one validation winner and independently audit it.
- Persist leases, callback attempts, budgets, audit consumption and immutable observations.
- Add immediate observation/rollback and optional application-owned canary coordination.
- Add trusted-source/partition helpers, paired audit bounds, stable cohort assignment and repeated-failure stops.
- Add three simulated application workflows in both languages; providers and scientific libraries remain outside core.
- Introduce explicit Node store v3 / Python store v2 migrations, preserving legacy records and rollback lineage.
- Reject the former experimental auto-apply authorization path. No automatic training, code modification or agent spawning.
- Retain isolated Azure model-backed evidence and an HTTP/PostgreSQL mock support lab covering retain, rejection, regression rollback and missing-feedback timeout. Synthetic inputs are explicitly labeled.
- Update both language guides, migration/reference documentation and landing-page autonomy descriptions. Production enablement remains a separate application decision.

## Python 0.2.0a1 — published 2026-09-12

- Add a native async Python 3.11+ package with a dependency-free core; Node remains unchanged.
- Port namespace-bound capture, strict validation, revisions, payload/sanitization hooks,
  episode-weighted analysis, immutable candidates, version-bound review and explicit deployment.
- Add persisted attempts, target reservations, inspect-only reconciliation, cancellation,
  atomic finalization and predecessor-based rollback; no Python auto-apply controller.
- Add an optional psycopg PostgreSQL adapter with separate Python v1 tables/locks and
  explicit packaged migration; no cross-language shared-record compatibility is claimed.
- Include adapter conformance, failure/concurrency regressions, offline accepted/rejected/
  interrupted examples, wheel/sdist installation checks, Python docs and CI.
- Add manual, exact-commit PyPI Trusted Publishing with validation gates, tested artifacts,
  provenance attestations and a protected publishing environment. No new npm release.

## Loopiter 0.2.0-alpha.1

- Rename the product, SDK package, CLI, error class and starter environment variables.
- Keep existing PostgreSQL table names and advisory-lock keys to preserve stored data
  and coordination with existing deployments. No database rename is required.
- Existing Feloop npm releases, deployment addresses and historical reports are unchanged.

## 0.2.0-alpha.1 — published as feloop

Breaking alpha; Node.js 22/24, MIT, ESM, dependency-free core.

- Replace global ID access and per-record namespaces with namespace-bound clients.
- Introduce v2 serializable adapter transactions, insert-only capture, revisions,
  pagination, explicit deletion, PostgreSQL migrations and adapter conformance tests.
- Bind evaluations and approvals to immutable content/evidence hashes and versions.
- Unify manual/controller deployment with durable attempts, receipts, target
  reservations, reconciliation and explicit rollback lineage.
- Deduplicate scored signals by episode/execution, support late observations,
  reject non-finite values, exclude zero weight and remove `Finding.confidence`.
- Default to recommendations; bound proposal calls/candidates and callbacks;
  require explicit experimental opt-in for low-risk prompt/routing auto-apply.
- Add a PostgreSQL/OpenAI classification starter and clearly simulated CI fixtures.
- Make Fern canonical; retire duplicate website documentation and unsupported claims.
- Add packaging smoke tests, runnable-doc checks and CI release gates.

See `docs/migration.md`. Old deployment history cannot safely become active.

## 0.1.0 — private prototype

Initial capture, heuristic analysis and callback-based lifecycle. Not a supported
production deployment contract. No unsafe compatibility wrappers are carried forward.
