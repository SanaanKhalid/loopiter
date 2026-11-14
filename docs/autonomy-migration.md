# Explicit 0.2 → 0.3 migration

This is a breaking development alpha. Do not mix old/new writers during migration,
and do not automatically enable autonomy while upgrading storage or code.

1. Stop application-owned schedules and new deployments. Inspect pending attempts and
   resolve them using the **old** deployment adapter/configuration first. Record actual
   serving versions and receipts. Do not discard uncertain attempts.
2. Back up the developer-owned database and application artifact registry. Test restoration
   into a disposable database. Keep the original SDK lockfile and serving configuration.
3. Review and explicitly execute SQL migration `002-autonomy.sql` for the appropriate SDK.
   Node migrations live in `migrations/`; Python SQL is packaged under
   `loopiter/migrations/`. `migratePostgres(pool)` and Python `migration_sql()` include
   the numbered migrations when explicitly invoked. Constructors never run DDL.
   Python schema version 2 still serves every collection except `historical`. A schema
   below 2 still fails closed and names `002-autonomy.sql`. Writing `historical` on a
   version-2 store fails with `migration_required` and names `003-historical.sql`.
   The script is two transactions, each with `SET LOCAL lock_timeout = '5s'` and the
   schema advisory lock. Transaction 1 drops the old check (`ACCESS EXCLUSIVE`, no scan)
   and adds the wider check `NOT VALID` (`SHARE UPDATE EXCLUSIVE`, no scan), then commits,
   so that exclusive lock does not cover validation. A `NOT VALID` check is still enforced
   for new rows. Transaction 2 runs `VALIDATE CONSTRAINT` only when `convalidated` is false.
   That scan uses `SHARE UPDATE EXCLUSIVE`, so reads and writes can proceed. The script
   does not rewrite rows and does not insert a schema version, so older SDKs still see
   `max(version) = 2`. The adapter allows `historical` only when that table's check names
   it. Running the file twice, or after an interrupt between the transactions, is safe.
   `historical_down_sql()` reads `003-historical-down.sql`, which is not part of
   `migration_sql()` and uses the same two-transaction shape. It restores the version-2
   check when no `historical` row exists, and transaction 1 rolls back without deleting
   rows when one does.
4. Upgrade adapters: Node contract version **3**, Python adapter contract version **2**.
   Python SQL schema version 2 still satisfies that adapter after `003-historical.sql`.
   New collections are
   runs, operations, budgets, observations and coordination. Observations are insert-only;
   mutable control records use revisions and namespace-serializable short transactions.
   Run the exported conformance suite against a disposable namespace.
5. Preserve existing executions, signals, candidates, receipts, target pointers and rollback
   lineage. SQL changes collection constraints; it does not rewrite those records. Existing
   deployed candidates remain inspectable and recoverable through manual lifecycle APIs.
6. Remove `apply` / `experimentalAutoApply`. Create fresh workflows with versioned policy,
   schemas, dataset eligibility, budgets and adapters. Old proposals/evaluations/approvals
   cannot authorize new autonomous work: controller candidates are fresh and baseline-bound.
7. For an existing installation, start in recommend, then experiment, then an explicitly
   isolated autonomous environment. Exercise failed monitoring, lost receipts, cancellation
   and rollback before any production enablement. Use one authoritative configuration and
   one SDK language per external target. Do not rewrite an existing schemaVersion 1
   onboarding plan. Fresh `init` plans (schemaVersion 2, preset `autonomous-default`)
   record autonomous mode separately. Constructing `ImprovementController` without a
   mode is now autonomous with self-improving on. That default is unreleased, on
   main, and is not in the published 0.3.0 alphas. Pass mode `recommend` to
   store proposals without applying them. Pass mode `observe` to inspect
   evidence without proposing. `--disable` and `LOOPITER_DISABLE=1`
   only pause the worker: the tick stops with `self_improvement_disabled` and
   stores no proposal. They are not mode recommend. `--enable`,
   `--confirm-activation`, and `--yes` are ignored and log a deprecation warning.
   Audit, budgets, and rollback still apply.

## JSON development stores

`migrateJsonV2(sourcePath, differentDestinationPath)` validates and writes a new v3 copy.
It never overwrites the source or an existing destination. Stop all writers first.
Keep the v2 original. The older prototype `importLegacyV1` path still treats unreliable
deployment history as historical; it does not silently activate old versions.

## Rollback of the SDK upgrade

Pause schedules and reconcile external operations before changing SDK versions. Do not
drop new collections or downgrade schema while autonomous work is pending. Restoring a DB
backup does **not** roll back an external prompt/router. Restore/reconcile the application
artifact registry independently, then restore the matching database/configuration backup
into an isolated environment and verify active pointers/receipts before resuming traffic.
There is no automatic destructive down migration.

## Callback and serving contract changes

Baseline-bound candidates include actual artifact version and relevant model/configuration
fingerprint. Deployment adapters must fence both in their serving transaction, persist
receipts under stable attempt IDs and inspect uncertainty without replay. An inspection
of `not_applied` must fence late calls; an absence of a receipt alone is not sufficient.

All metered calls reserve bounded request/token allowance before dispatch. Unknown completion
keeps reservations. Daily deployment limits count new apply attempts; emergency rollback is
not prevented by an exhausted apply budget. Application/provider quotas remain necessary.

Node and Python have separate tables and serialization. Behavioral fixtures test shared
decisions, not cross-language wire compatibility. Never migrate one language's records into
the other's store or independently control the same external target from both.
