-- Reverses 003-historical.sql. Not included in migration_sql(). Constructors never run it.
-- If any historical row exists, transaction 1 raises and rolls back. It does not delete rows.
-- When no historical row exists, transaction 1 restores the version-2 check as NOT VALID
-- and commits. That ACCESS EXCLUSIVE lock ends before validation. New rows are still checked.
-- Transaction 2 validates only when pg_constraint.convalidated is false, under
-- SHARE UPDATE EXCLUSIVE, so reads and writes can proceed during the scan.
-- It also removes a version 3 marker if one was recorded, so max(version) stays 2.
-- SET LOCAL lock_timeout = '5s' and the same advisory lock as 003-historical.sql.
-- Re-running is safe, including after an interrupt between the two transactions.
-- If the check does not allow historical, transaction 1 skips the ALTER statements.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
DO $migration$
DECLARE
  definition text;
BEGIN
  IF EXISTS (SELECT 1 FROM loopiter_python_records WHERE collection = 'historical') THEN
    RAISE EXCEPTION 'historical rows exist; 003-historical-down.sql refuses to remove them';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'loopiter_python_records'::regclass
    AND conname = 'loopiter_python_records_collection_check';
  IF definition IS NULL OR definition NOT LIKE '%historical%' THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check';
  EXECUTE $sql$ALTER TABLE loopiter_python_records
    ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination'))
    NOT VALID$sql$;
END
$migration$;
COMMIT;
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
DO $migration$
DECLARE
  validated boolean;
BEGIN
  SELECT convalidated INTO validated
  FROM pg_constraint
  WHERE conrelid = 'loopiter_python_records'::regclass
    AND conname = 'loopiter_python_records_collection_check';
  IF validated IS NULL OR validated THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE loopiter_python_records VALIDATE CONSTRAINT loopiter_python_records_collection_check';
END
$migration$;
DELETE FROM loopiter_python_schema_migrations WHERE version = 3;
COMMIT;
