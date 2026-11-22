# Changelog

## Unreleased

### Breaking

- **Migration:** On main, unreleased, `ImprovementController` constructed without a mode is autonomous with self-improving on, in Node and Python, matching the `autonomous-default` init preset. A worker with no integration plan uses autonomous and logs that fallback. The worker runs without `--enable`. Existing users who never set a mode previously stayed on recommend and did not apply. To store proposals without applying them, pass mode `recommend` or set `plan.mode` to `recommend`. To inspect evidence without proposing, pass mode `observe` or set `plan.mode` to `observe`. `--disable`, or `LOOPITER_DISABLE` set to any non-empty value except `0`, `false`, `no`, or `off` (case-insensitive, trimmed), is a full pause: the worker returns `self_improvement_disabled` before importing the application, in every mode, and makes no provider call. It is not mode recommend. `selfImproving: false` / `self_improving=False` pauses the controller the same way before any callback. `--enable`, `--confirm-activation`, and `--yes` are ignored and log a deprecation warning. Activation confirmation is no longer required. Validation, held-out audit, budgets, fixed checks, must-pass examples, audit history, and rollback are unchanged. This is not in the published npm `0.3.0-alpha.1` or Python `0.3.0a1` packages, which still default the controller to recommend and still require `--enable`. No version bump and no release.

### Minor

- The benchmark harness records which candidate a production rollback undid. A later accepted candidate on the same seed stays served. Decision logs that only say `rolled_back` still drop the latest accepted candidate. Transient network errors, timeouts, and HTTP 500, 502, 503, and 504 retry on one configurable attempt budget (`LOOPITER_BENCH_NETWORK_ATTEMPTS`, default 4, or `--network-attempts`). Backoff stays inside the per-call wait cap, and a listed server error honors `Retry-After`. Other 5xx responses and 4xx responses are not retried. HTTP 429 keeps its own budget. Exhausting the shared budget fails the current seed and counts toward the consecutive-failure stop. The total and per-invocation spend caps remain the hard bound. The controller step reserves those attempts as the request timeout plus two pace windows plus the ledger write, and refuses to start when that budget exceeds the step cap. Request pacing takes its slot after the token reservation, and the token reservation moves to the send time if that wait is non-zero. A network failure while scoring a served candidate is recorded on that seed. `LOOPITER_BENCH_MAX_RPM` and `--max-rpm` optionally pace requests per minute and compose with `LOOPITER_BENCH_MAX_TPM` / `--max-tpm`. Unset request pacing is unchanged. Progress lines can include HTTP 429 responses per completed call.
- A served answer has a stable id from `namespace`, `answer`, and optional `episodeId` and `artifactVersion`, the same in Node and Python. The id uses the eval-set lock's canonical JSON, so non-ASCII text matches across the SDKs. `recordFeedback` / `record_feedback` stores a numeric rating from 0 to 1, thumbs up or down, and/or a corrected edit, with an optional note, for one target. Unknown fields, over-long text, and control characters are rejected. Length is counted in Unicode code points. The feedback cursor for that target advances, on promotion, only to the feedback the run had seen when it started, and rewinds when that promotion is rolled back, in the same store transaction. Each row has a per-target sequence allocated with the head row's conditional write, and the cursor compares that sequence only. A malformed cursor does not block the rollback receipt; the next promotion fails closed on that row. Optional `caps` limit currency spent in a UTC month and improvement runs in a UTC day, per target. A tick that does not call a model does not count as a run. One `callCost` / `call_cost` charge is one model operation, including each evaluation batch. `budget_cap` and `daily_run_cap` are recorded without spending. A corrupt counter or a revision conflict on a counter stops the model call; the conflict pauses the run. `npm pack` deletes `dist` before the build, so a stale file cannot be packed.
- An eval set can be locked, and train data can be checked for exact overlap with it. `lockEvalSet` / `lock_eval_set` hashes the items with SHA-256 after sorting them by UTF-8 id. Object keys are in a stable order. The hash covers each id, input, and expected output, and the lock records the item count and the hashing scheme version. `verifyEvalLock` / `verify_eval_lock` refuses an added, removed, or edited item. It reports how many ids were added, removed, and changed, and it does not print the item contents. Writing the lock again is how a suite is explicitly re-locked. `checkEvalLeakage` / `check_eval_leakage` reports ids that overlap by exact id or by a normalized content hash. Normalization is Unicode NFC plus collapsed whitespace, on `input` and `expected` unless `--fields` selects a subset. Leading and trailing characters are removed only when they are in that same set. Matching is exact. The controller option `requireEvalLock` (`require_eval_lock` in Python) checks the loaded validation and audit rows against the lock after the dataset is read and before a model or evaluator call. Leaving the option unset leaves the check disabled, so an existing controller is unchanged. `loopiter eval lock`, `loopiter eval verify`, and `loopiter eval leakage` are the same commands through `python -m loopiter`. Text output escapes every character outside printable ASCII, and `--json` is ASCII-only. Verify exits nonzero when the suite drifts. Leakage exits nonzero when any id overlaps. Reported ids are capped at 20; the counts are not. The public benchmark harness checks the committed fixture eval locks before a fixture run. When a pinned eval lock is present, cache load checks it and stops before any model call if the loaded split differs. The harness call plan, reservations, and budget are unchanged.
- Node loads its failure-detail rules from a TypeScript module generated from the Python rules file (`node scripts/generate-failure-detail-rules.mjs`). A bundled build loads the controller without reading a rules file at runtime, and loading the controller does not warn on Node 22. Python ships the same rules as package data beside the module.
- `selfImproving: false` / `self_improving=False` pauses every mode, including autonomous, recommend, experiment, and observe. The controller returns `self_improvement_disabled` and does not call the provider. With self-improving on, experiment and observe run up to their own gates, and autonomous ticks only when the workflow is not paused. `LOOPITER_DISABLE` is read inside `tick()`, not only by the worker command.
- Confidence acceptance can keep a per-agent best-ever control score and block a promotion that regresses past it. `retention` (`retention` in Python) is off unless a confidence policy sets `margin` and, optionally, `confidence`. The check pairs the candidate's control-split item scores with the stored best-ever scores by id, sorted by UTF-8 bytes, and uses the same fixed-seed paired bootstrap as the acceptance gate. The candidate fails when the lower bound of (candidate − best-ever), in the objective direction, is below `-margin`. That blocks promotion and is logged as `retention_regression`. Too few decisive overlapping items is `insufficient` and does not deploy. No best-ever record, or no shared ids, is `not_measured` with nulls, never 0. After a promotion that passes, the record updates only when the new control mean is strictly better. Rollback does not lower it. The ledger stays on schema version 1 beside controller state, with optional `decision.retention` fields so older decision logs still read. `loopiter retention status` and `python -m loopiter retention status` print the record and the last decisions and write nothing. `explain` prints the retention result. The public benchmark harness does not enable this check, so its call plan and reservations are unchanged.
- `decideAcceptance` / `decide_acceptance` rejects unknown paired item fields. A leftover `baseline`, or any field other than the paired scores, is now an error, so callers that pass extra fields fail instead of having those fields ignored. This shipped in #54.
- Confidence acceptance can measure an optional noise floor. `noiseFloor` (`noise_floor` in Python) is off unless a confidence policy sets `validation` and/or `audit`. The incumbent is scored a second time on that split, which doubles incumbent scoring there, and the same paired bootstrap, confidence, fixed seed, and id order supply an upper bound on the absolute effect of the two runs. The candidate's lower bound must clear the larger of `minimumEffect` and that bound. The decision log records the bound, the method, the item count, the extra calls, which threshold was binding, and the effective threshold. A check that did not run records null and `not_measured`, not 0. Fixed-margin policies stay unchanged. The public benchmark harness does not enable this floor yet, so its call plan and reservations are unchanged. `explain` prints the floor. Its text escapes every character outside printable ASCII, including DEL, and `--json` emits ASCII-only JSON in both SDKs. Parsed strings round-trip.
- Confidence acceptance can return `insufficient` when a validation or audit check has fewer decisive items (scores that differ) than `minimumValidationDecisive` / `minimumAuditDecisive` (`minimum_validation_decisive` / `minimum_audit_decisive` in Python). The default is a sign-test floor, the smallest unanimous decisive count whose one-sided tail falls under the interval tail: 5 at confidence 0.90, because `2^-5` is under 0.05 and `2^-4` is not. A confidence policy cannot set a lower decisive minimum. That check is not a pass and not a rejection. Nothing deploys, the incumbent keeps serving, and the controller records the decision and waits for more evidence without incrementing the consecutive-failure stop. An insufficient audit is stored with outcome `insufficient`, reason `insufficient_decisive`, and the decisive counts, not as an ordinary failed audit. `validatePolicy` / `validate_policy` rejects a decisive minimum below that floor and requires `minimumValidationUnits` and `minimumAuditUnits` to be at least the same floor. Fixed-margin policies are unchanged. `loopiter explain` and `python -m loopiter explain` read a decision log, including logs written before this field, and print each seed's accepted, rejected, or insufficient checks. A check that did not run is null, not 0.
- HotpotQA and IFBench accept `--validation-rows` and `--audit-rows` on `--live`, `--estimate`, and `--fixtures`. Defaults remain 150 and 300. Held-out stays 300. An odd audit count gives the one-shot rewrite the extra row.
- An optional objective `acceptance` of `confidence` accepts a candidate when the lower bound of a paired bootstrap interval clears `minimumEffect` (default 0). `confidence` defaults to 0.90, `bootstrapSamples` to 2000 with a ceiling of 100000, `bootstrapSeed` is fixed, and `minimumItems` defaults to 0. The fields are `minimum_effect`, `confidence`, `bootstrap_samples`, `bootstrap_seed`, and `minimum_items` in Python. This mode requires immediate rollout and no custom audit method. Other policies keep the fixed `minimumImprovement` margin, including onboarding and canary observation.
- IFBench records a listed provider policy refusal (`cyber_policy`, `content_filter`, or `ResponsibleAIPolicyViolation`) as an item failure and continues later seeds. A throw inside one seed is stored on that seed and later seeds still run. A seed whose propose calls are all refused is `never_proposed`, with the refusal counts on the report. Exhausted network, timeout, and listed server retries fail that seed and count toward the consecutive-failure stop. A persistent 429, auth failures, the budget cap, an unlisted invalid_request code, and a malformed request stop the run.
- A disabled worker no longer logs the missing-plan fallback warning. `LOOPITER_DISABLE=enable` and `LOOPITER_DISABLE=enabled` still disable, and the worker warns that those words do not turn work on. A `--disable` worker does not observe or roll back a canary that is already running; `pause` keeps observation and recovery, and rollback is an explicit adapter call.
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
