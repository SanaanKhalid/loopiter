# Changelog

## Unreleased

### Minor

- The controller step timeout is configurable from the controller, `stepTimeoutMs` in the integration plan, and `--step-timeout-ms`. The default remains 120 seconds and the deadline cannot exceed one hour. A step that fails only by timeout is recorded as `timed_out`, does not consume audit rows, and does not increment the consecutive-failure stop. It is retried once; a second timeout ends that run. Repeated timeouts pause separately from real failures and still cannot deploy.
- Doctor and an autonomous worker refuse an audit size that cannot certify the configured gain at the configured confidence. The paired Hoeffding minimum is `minimumCertifiableAuditUnits` / `minimum_certifiable_audit_units`. Fresh plans record an audit size that can pass. Confidence thresholds are unchanged.
- The worker uses `plan.mode` when `--mode` is omitted. The flag overrides the plan, and the effective mode and step timeout are logged with their source.
- The starter Postgres registry can update a setup's configuration hash without replacing the artifact version.
- Candidates left proposed by a timed-out or cancelled run are rejected when the run ends, and stale ones are rejected on startup.
- The first `--enable` run in autonomous mode asks for the one-time activation confirmation. `--confirm-activation` or `--yes` records it in `.state/activation.json` for that namespace and plan, with who confirmed it, when, and a hash of the autonomy settings, including the plan's policy and budget. Later runs reuse the stamp. A new namespace or a change to those settings asks again. The stamp is a consent record: it is not signed and it is not bound to a machine. `.state/` is gitignored, and `init` appends that pattern to an existing `.gitignore` without duplicating it.
- Node `--step-timeout-ms` and `stepTimeoutMs` in the plan accept only decimal integers. Scientific notation, hex, and trailing `.0` are rejected, matching Python.

- Fresh self-hosted `init` writes onboarding plan schemaVersion 2, preset `autonomous-default`, in Node and Python: `mode` autonomous and self-improving on. Doctor still accepts schemaVersion 1 plans and does not rewrite them.
- `ImprovementController` constructed without a mode still recommends and does not apply. The worker still requires `--enable` before spending. New setup recipes pass `--enable --mode autonomous` after doctor and verify. `--mode recommend` remains one flag away. Omitting `--mode` follows `plan.mode`.
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
