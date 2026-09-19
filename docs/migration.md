# Migration from the private v0.1 prototype

This historical guide describes the original 0.1 → 0.2 upgrade. Use
[the 0.3 migration guide](autonomy-migration.md) for the new store contracts and autonomy.

This is a clean breaking release. Stop old writers and back up the original JSON
file before importing. Never point the v2 JsonFileStore at a v1 file: it refuses it.
Use a new database/JSON destination and keep the original unchanged.

1. Replace `new FeedbackLoop({ store })` with `{ store, namespace }`.
2. Remove namespace properties from execution, signal and candidate creation calls.
3. Replace independent `save*` adapters with `FeedbackStore.version = 2` and the
   documented namespace-serializable transaction contract. Run conformance tests.
4. Supply real signal `source`, runtime-valid risk/target enums and finite metrics.
5. Replace a bare deployer callback with apply/inspect/rollback and durable receipts.
6. Recreate candidates with evidence manifests, evaluation versions and an independent
   dataset hash; re-evaluate and approve. Do not import old approvals as trustworthy.
7. Update analysis gates: support/scoredCount count episodes where available;
   executionCount and uniqueSignalCount are separate. `Finding.confidence` is removed.
8. Configure separate `executionWindow` and `observationWindow`, using UTC timestamps
   and half-open bounds. Absence of an effect never passes a positive-effect threshold.

## Export and import old JSON

The v1 JSON store is already its full export: `{version:1, executions, signals,
candidates}`. Copy/back it up using your normal filesystem tooling. Import explicitly:

```sh
npx loopiter import-v1 --input ./backup-v1.json --file ./imported-v2.json --namespace support/dev
npx loopiter export --file ./imported-v2.json --namespace support/dev
```

These commands are available after tarball installation/publication. To run from
source use `node dist/src/cli.js` in place of `npx loopiter` after `npm run build`.
The CLI refuses identical input/output paths. No source file is rewritten. The
second command emits a namespace snapshot to stdout; it is not a v1 import format
or a database backup/restore service.

To import into PostgreSQL instead, read the v1 document in your migration program
and call exported `importLegacyV1(loop, document)` with a PostgreSQL-backed client.
Imports filter the client's namespace; resolve parent order and reject cycles.
Execution/signal IDs are preserved and conflicts fail instead of overwriting.
Partial imports are rerunnable with identical input; migration is not one huge
transaction. Review failures and counts before resuming writers.

Candidate/deployment records go only to insert-only `historical` records, preserving
the original JSON. They never create approvals, attempts or active pointers.
Unknown predecessors cannot be reconstructed honestly. Importing history does not
change your currently deployed artifact; adopt that artifact as an explicit baseline
through your new deployment adapter, then evaluate fresh candidates.
# Renaming from Feloop to Loopiter

Install the renamed package with `npm install loopiter@0.2.0-alpha.1`.
Change imports from `feloop` to `loopiter` (including `/postgres` and `/testing`),
the CLI command to `loopiter`, and `FeloopError` to `LoopiterError`.
For the starter and PostgreSQL tests, rename `FELOOP_*` environment variables to
`LOOPITER_*`. These are breaking interface changes; no old-name aliases are provided.

Keep your existing database and namespace. SQL table names and advisory-lock keys
retain their legacy `feloop` identifiers deliberately: changing them would hide
existing data or break coordination with older clients. No schema rename is needed.
Historical release reports retain their original identities.
