-- Explicit Python contract v2 migration. Back up first; no existing rows are rewritten.
-- If the collection check already allows historical, it is a superset of this check.
-- Leave it in place so a re-run does not narrow the table or scan it again.
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
  EXECUTE $sql$ALTER TABLE loopiter_python_records ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination'))$sql$;
END
$migration$;
INSERT INTO loopiter_python_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
