-- Optional. Constructors never run this file. It does not insert a schema version.
-- Older Python SDKs still require max(version) = 2, and this script leaves that row in place.
-- It only widens loopiter_python_records_collection_check so historical is allowed.
-- No rows are rewritten. migration_sql() includes this text only when executed.
--
-- Locking, inside one transaction:
--   SET LOCAL lock_timeout = '5s' makes a blocked lock fail instead of waiting.
--   pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0)) is held
--   until commit, so two migration sessions serialize.
--   DROP CONSTRAINT takes a brief ACCESS EXCLUSIVE lock and does not scan rows.
--   ADD CONSTRAINT ... NOT VALID takes SHARE UPDATE EXCLUSIVE and does not scan rows.
--   VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE,
--   so SELECT, INSERT, UPDATE, and DELETE can proceed during the scan.
-- Running this file twice is a no-op when the check already allows historical.
-- The reverse script is 003-historical-down.sql and is not part of migration_sql().
BEGIN;
SET LOCAL lock_timeout = '5s';
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
DELETE FROM loopiter_python_schema_migrations WHERE version = 3;
COMMIT;
