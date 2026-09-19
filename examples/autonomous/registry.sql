-- Application-owned artifact registry for the Node reference workflows.
-- Execute explicitly, never from an SDK/adapter constructor.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/autonomous-example/schema/v1',0));
CREATE TABLE IF NOT EXISTS loopiter_example_artifacts (
  scope text NOT NULL, version text NOT NULL, artifact jsonb NOT NULL,
  PRIMARY KEY(scope,version)
);
CREATE TABLE IF NOT EXISTS loopiter_example_targets (
  scope text PRIMARY KEY, version text NOT NULL, configuration_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS loopiter_example_receipts (
  scope text NOT NULL, attempt_id text NOT NULL, request_hash text NOT NULL, receipt jsonb,
  PRIMARY KEY(scope,attempt_id)
);
COMMIT;
