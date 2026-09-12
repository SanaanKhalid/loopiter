-- Python contract v1 only. Review and apply explicitly; never run on construction.
-- Separate from Node's feloop_records: not a cross-language storage protocol.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('loopiter/python/schema/v1', 0));
CREATE TABLE IF NOT EXISTS loopiter_python_schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS loopiter_python_records (
    namespace text COLLATE "C" NOT NULL,
    collection text NOT NULL CHECK (collection IN ('executions', 'signals', 'candidates', 'targets', 'attempts', 'events')),
    id text COLLATE "C" NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    event_time timestamptz NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (namespace, collection, id),
    CHECK (jsonb_typeof(body) = 'object'),
    CHECK (body->>'namespace' = namespace),
    CHECK (body->>'id' = id),
    CHECK ((body->>'revision')::bigint = revision)
);
CREATE INDEX IF NOT EXISTS loopiter_python_records_time
    ON loopiter_python_records (namespace, collection, event_time);
INSERT INTO loopiter_python_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
