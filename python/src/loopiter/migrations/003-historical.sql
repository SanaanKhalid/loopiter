-- Optional Python schema v3. Constructors never run this file.
-- A store at schema version 2 keeps serving every collection except historical.
-- This file only widens loopiter_python_records_collection_check so historical is allowed.
-- It does not rewrite rows. Apply it explicitly; migration_sql() includes this text
-- only when the application executes that function.
--
-- Locking, inside one transaction:
--   pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0)) is held
--   until commit, so two migration sessions serialize.
--   DROP CONSTRAINT takes a brief ACCESS EXCLUSIVE lock and does not scan rows.
--   ADD CONSTRAINT ... NOT VALID takes SHARE UPDATE EXCLUSIVE and does not scan rows.
--   VALIDATE CONSTRAINT then scans under SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE,
--   so SELECT, INSERT, UPDATE, and DELETE can proceed during the scan. The scan does
--   not rewrite rows. Every collection the previous check allowed is still allowed.
-- Running this file twice is a no-op: when the check already allows historical, the
-- ALTER statements are skipped. The version insert uses ON CONFLICT DO NOTHING.
-- migration_sql() runs 002 before this file, and 002 installs the narrower check, so
-- this file widens it again even if version 3 was already recorded.
-- The reverse script is 003-historical-down.sql and is not part of migration_sql().
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
DO $migration$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conname = 'loopiter_python_records_collection_check';
  IF definition LIKE '%historical%' THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check';
  EXECUTE $sql$ALTER TABLE loopiter_python_records
    ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination','historical'))
    NOT VALID$sql$;
  EXECUTE 'ALTER TABLE loopiter_python_records VALIDATE CONSTRAINT loopiter_python_records_collection_check';
END
$migration$;
INSERT INTO loopiter_python_schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;
