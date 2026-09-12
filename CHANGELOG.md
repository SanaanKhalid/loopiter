# Changelog

## Python 0.2.0a1

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
