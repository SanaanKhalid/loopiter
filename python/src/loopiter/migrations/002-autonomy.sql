-- Explicit Python contract v2 migration. Back up first; no existing rows are rewritten.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
ALTER TABLE loopiter_python_records DROP CONSTRAINT IF EXISTS loopiter_python_records_collection_check;
ALTER TABLE loopiter_python_records ADD CONSTRAINT loopiter_python_records_collection_check
    CHECK (collection IN ('executions','signals','candidates','targets','attempts','events',
                         'runs','operations','budgets','observations','coordination'));
INSERT INTO loopiter_python_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
