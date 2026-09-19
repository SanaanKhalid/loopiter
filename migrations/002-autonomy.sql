-- Explicit upgrade; stop old and new writers and back up before running.
-- Keep the v2 advisory key so accidentally overlapping clients still serialize.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('feloop/schema/v2', 0));
ALTER TABLE feloop_records DROP CONSTRAINT IF EXISTS feloop_records_collection_check;
ALTER TABLE feloop_records ADD CONSTRAINT feloop_records_collection_check CHECK
 (collection IN ('executions','signals','candidates','targets','attempts','events','historical',
 'runs','operations','budgets','observations','coordination'));
INSERT INTO feloop_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
