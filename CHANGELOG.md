# Changelog

## Unreleased

### Breaking

- **Migration:** On main, unreleased, `ImprovementController` constructed without a mode is autonomous with self-improving on, in Node and Python, matching the `autonomous-default` init preset. A worker with no integration plan uses autonomous and logs that fallback. The worker runs without `--enable`. Existing users who never set a mode previously stayed on recommend and did not apply. To store proposals without applying them, pass mode `recommend` or set `plan.mode` to `recommend`. To inspect evidence without proposing, pass mode `observe` or set `plan.mode` to `observe`. `--disable`, or `LOOPITER_DISABLE` set to any non-empty value except `0`, `false`, `no`, or `off` (case-insensitive, trimmed), is a full pause: the worker returns `self_improvement_disabled` before importing the application, in every mode, and makes no provider call. It is not mode recommend. `selfImproving: false` / `self_improving=False` pauses the controller the same way before any callback. `--enable`, `--confirm-activation`, and `--yes` are ignored and log a deprecation warning. Activation confirmation is no longer required. Validation, held-out audit, budgets, fixed checks, must-pass examples, audit history, and rollback are unchanged. This is not in the published npm `0.3.0-alpha.1` or Python `0.3.0a1` packages, which still default the controller to recommend and still require `--enable`. No version bump and no release.

### Minor

- IFBench records a provider policy refusal, including a 400 `cyber_policy` or `content_filter`, as an item failure and continues later seeds. A controller call is recorded the same way. Auth failures, the budget cap, and a malformed request that is not a policy refusal still stop the run.
- A disabled worker no longer logs the missing-plan fallback warning. `LOOPITER_DISABLE=enable` and `LOOPITER_DISABLE=enabled` still disable, and the worker warns that those words do not turn work on. A `--disable` worker does not observe or roll back a canary that is already running; `pause` keeps observation and recovery, and rollback is an explicit adapter call.
- `selfImproving: false` / `self_improving=False` pauses every mode, including recommend and experiment. A controller created with `mode: "recommend"` and that flag returns `self_improvement_disabled` and does not propose. `LOOPITER_DISABLE` is read inside `tick()`, not only by the worker command.
- Node's public `loopiter/onboarding` helpers `autonomousActivationCurrent`, `autonomousActivationPrompt`, `moduleActivationNamespace`, `effectiveBudgetFingerprint`, `activationBudgetCurrent`, `recordAutonomousActivation`, and `clearAutonomousActivation` are deprecated warning no-ops. Activation confirmation is retired. The same Python helpers were not in `__all__` and are removed.
- Honor the disable setting in all apply paths.
- Clean up state when the disable check stops an apply.
- Site and docs samples pass mode recommend explicitly. Omitting the controller mode is autonomous with self-improving on, on main, and arrives in the next release. The published v0.3.0-alpha.1 still defaults to recommend. The ambiguous disable warning is once per process in both SDKs, and Python exports `warn_ambiguous_improvement_disable`.
- The controller step timeout is configurable from the controller, `stepTimeoutMs` in the integration plan, and `--step-timeout-ms`. The default remains 120 seconds. Node and Python share a two-hour ceiling on the controller, the integration plan, and `--step-timeout-ms`, so the live KB-QA harness can cover its retries. A step that fails only by timeout is recorded as `timed_out`. Audit rows already sent to the model stay reserved, and the timeout does not increment the consecutive-failure stop. It is retried once; a second timeout ends that run. Repeated timeouts pause separately from real failures and still cannot deploy.
- The live stall watchdog uses a monotonic clock. A host pause that jumps wall time ahead of that clock is logged and is not treated as a stall. Stopping a live run reports the candidate as cancelled. A callback failure keeps a redacted, truncated error instead of a generic failure code. Held-out scoring is skipped when a failed candidate is still serving the baseline.
- Callback failures store a redacted, truncated error on the improvement run in both SDKs. The worker no longer asks for an activation confirmation, and it does not read or rewrite `.state/activation.json`.
- Strengthen error-text sanitizing for stored failure detail in both SDKs.
- Tighten error-text sanitizing for stored failure detail in both SDKs.
- Doctor and an autonomous worker refuse an audit size that cannot certify the configured gain at the configured confidence. The paired Hoeffding minimum is `minimumCertifiableAuditUnits` / `minimum_certifiable_audit_units`. Fresh plans record an audit size that can pass. Confidence thresholds are unchanged.
- The worker uses `plan.mode` when `--mode` is omitted. The flag overrides the plan, and the effective mode and step timeout are logged with their source.
- The starter Postgres registry can update a setup's configuration hash without replacing the artifact version.
- Candidates left proposed by a timed-out or cancelled run are rejected when the run ends, and stale ones are rejected on startup.
- The worker recipe omits `--mode` so `plan.mode` controls it.
- Audit rows are reserved when they are sent to the model. A timed-out audit cannot be reused by a later run.
- Doctor describes `minimumImprovement` as the certification floor. For the default objective, 7 units is the full-range floor; a gain of 0.05 cannot be certified, while gains of 0.10 and 0.20 need 2397 and 267 units.
- Node `--step-timeout-ms` and `stepTimeoutMs` in the plan accept only decimal integers. Scientific notation, hex, and trailing `.0` are rejected, matching Python.
- The live KB-QA harness retries only the listed transient socket failures, bounds each attempt with a deadline, and exits if the run goes quiet. The retry-wait cap is per call and does not include pace waits. A partial report keeps finished per-seed scores. Pacing still uses 90% of `LOOPITER_BENCH_MAX_TPM`.
- The live KB-QA harness sets the controller step from the calls in one callback, the reserved attempts, and the retry sleep those calls can spend.
- Fresh self-hosted `init` writes onboarding plan schemaVersion 2, preset `autonomous-default`, in Node and Python: `mode` autonomous and self-improving on. Doctor still accepts schemaVersion 1 plans and does not rewrite them.
- Fresh setup recipes run the worker without `--enable`. `--mode recommend` stores proposals and does not apply. `--disable` pauses and stores no proposal. Omitting `--mode` follows `plan.mode`. With no plan, the worker uses autonomous.
- Autonomous mode still fails closed without an audit partition or a budget. Validation, audit, minimum improvement, guardrails, trusted sources, budgets, cooldown, the consecutive-failure stop, canary promotion, observation rollback, pause, and lease checks are unchanged. No storage migration.

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
