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
   both numbered migrations when explicitly invoked. Constructors never run DDL.
4. Upgrade adapters: Node contract version **3**, Python version **2**. New collections are
   runs, operations, budgets, observations and coordination. Observations are insert-only;
   mutable control records use revisions and namespace-serializable short transactions.
   Run the exported conformance suite against a disposable namespace.
5. Preserve existing executions, signals, candidates, receipts, target pointers and rollback
   lineage. SQL changes collection constraints; it does not rewrite those records. Existing
   deployed candidates remain inspectable and recoverable through manual lifecycle APIs.
6. Remove `apply` / `experimentalAutoApply`. Create fresh workflows with versioned policy,
   schemas, dataset eligibility, budgets and adapters. Old proposals/evaluations/approvals
   cannot authorize new autonomous work: controller candidates are fresh and baseline-bound.
7. Start in recommend, then experiment, then an explicitly isolated autonomous environment.
   Exercise failed monitoring, lost receipts, cancellation and rollback before any production
   enablement. Use one authoritative configuration and one SDK language per external target.

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
