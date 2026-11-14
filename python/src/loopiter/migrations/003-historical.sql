-- Explicit Python contract v3 migration. Review and apply it; construction never runs it.
-- Widens the collection check to allow 'historical'. No rows are rewritten.
-- Existing rows are scanned so Postgres can validate the new check. Every value the
-- previous check allowed is still allowed, so that scan does not change data.
-- Running this file twice drops and recreates the same check, then inserts version 3
-- again (ON CONFLICT DO NOTHING).
--
-- Down, not included in migration_sql(). If any historical row exists, the restored
-- check fails and the transaction rolls back, leaving version 3 and every row in place:
-- BEGIN;
-- SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
-- ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check;
-- ALTER TABLE loopiter_python_records ADD CONSTRAINT loopiter_python_records_collection_check
--     CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
--                          'runs','operations','budgets','observations','coordination'));
-- DELETE FROM loopiter_python_schema_migrations WHERE version = 3;
-- COMMIT;
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check;
ALTER TABLE loopiter_python_records ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination','historical'));
INSERT INTO loopiter_python_schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;
