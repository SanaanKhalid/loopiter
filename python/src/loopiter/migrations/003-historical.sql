-- Optional. Constructors never run this file. migration_sql() does not include it.
-- Call historical_sql() explicitly. It does not insert a schema version.
-- Older Python SDKs still require max(version) = 2, and this script leaves that row in place.
-- It only widens loopiter_python_records_collection_check so historical is allowed.
-- No rows are rewritten. A NOT VALID check is still enforced for new rows.
-- Running the file twice is safe, including after an interrupt between the two transactions.
-- The reverse script is 003-historical-down.sql and is not part of migration_sql().
--
-- Transaction 1 is brief. SET LOCAL lock_timeout = '5s' makes a blocked lock fail
-- instead of waiting. The advisory lock serializes migration sessions until this
-- transaction commits. DROP CONSTRAINT takes ACCESS EXCLUSIVE and does not scan.
-- ADD CONSTRAINT ... NOT VALID takes ACCESS EXCLUSIVE and does not scan.
-- Those locks end at this COMMIT, before validation.
-- Transaction 2 takes the advisory lock again and VALIDATE CONSTRAINT only when
-- pg_constraint.convalidated is false. Validation uses SHARE UPDATE EXCLUSIVE, so
-- SELECT, INSERT, UPDATE, and DELETE can proceed during the scan.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
DO $migration$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'loopiter_python_records'::regclass
    AND conname = 'loopiter_python_records_collection_check';
  IF definition LIKE '%historical%' THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check';
  EXECUTE $sql$ALTER TABLE loopiter_python_records
    ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination','historical'))
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
