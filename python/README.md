# Loopiter for Python

Native, async Python SDK for **reviewed, evidence-driven AI improvements**.
No Node.js subprocess, hosted service, model dependency, telemetry, or core runtime
dependencies. Python **3.11+**, MIT. Python alpha version: **0.2.0a1** (PEP 440).

## Install the Python alpha

```sh
python -m pip install 'loopiter==0.2.0a1'
# Optional PostgreSQL adapter:
python -m pip install 'loopiter[postgres]==0.2.0a1'
```

Use an explicit version for this prerelease. The Node.js SDK is distributed separately
on npm; installing either SDK does not install the other.

## Run the offline example from source

```sh
git clone https://github.com/SanaanKhalid/loopiter.git
cd loopiter
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install ./python
python python/examples/reviewed_loop.py
python python/examples/reviewed_loop.py --reject
python python/examples/reviewed_loop.py --interrupt
```

Use an installed Python 3.11 or newer. The example runs offline, prints measured
fixture metrics, and demonstrates explicit approval, a real change to its in-process
classifier, rollback and interrupted-apply recovery. **Simulated fixtures, not LLM
performance evidence.** Its in-memory deployment registry is not production storage.

## Capture feedback

```python
import asyncio
from loopiter import FeedbackLoop, InMemoryStore


async def main():
    loop = FeedbackLoop(store=InMemoryStore(), namespace="support/dev")
    execution = await loop.record_execution(
        id="request-123",
        kind="prediction",
        episode_id="ticket-123",
        input={"text": "Please explain this charge."},
        output={"label": "other"},
        artifacts={"model": "your-model-version", "prompt": "intent-v1"},
        metadata={"intent": "billing"},
    )
    await loop.record_signal(
        id="review-123",
        execution_id=execution["id"],
        kind="correction",
        name="verified_correct",
        value=False,
        correction={"label": "billing"},
        source="authorized-reviewer",
        confidence=1,
    )
    findings = await loop.analyze(
        dimensions=["metadata.intent"],
        minimum_support=1,
        minimum_scored_count=1,
    )
    print(findings)
    await loop.close()


if __name__ == "__main__":
    asyncio.run(main())
```

All records are detached plain dictionaries using **snake_case**; access IDs with
`record["id"]`. Use `await` in an existing async application instead of nesting
`asyncio.run`. Inputs must be plain JSON; timestamps are ISO UTC strings ending in
`Z`. Unknown fields, NaN/infinity, non-string keys, cycles, NUL/lone-surrogate strings and missing safety fields
fail closed. Use explicit IDs to retry identical sanitized input idempotently;
conflicting input raises `LoopiterError(code="conflict")`. Defaults omitted on the
first request must remain omitted on retries. Revisions protect explicit updates.

Namespaces are integrity scopes, **not authentication**. Verify correction sources,
select authorized namespaces, and sanitize sensitive content in your application.
An async `sanitize(value)` hook runs before persistence and must return valid JSON;
failure never falls back to unsanitized input. Defaults: 256 KiB per input and
120 seconds per async callback. Sanitizers must be deterministic for retries and
must preserve deployment identity fields. Loopiter sends no data anywhere except
your explicitly supplied store and callbacks.

## PostgreSQL (optional)

```sh
python -m pip install 'loopiter[postgres]==0.2.0a1'
```

Review the packaged versioned migration before running it with an authorized setup
identity. Constructors never execute migrations. Request-time credentials do not
need schema-creation permissions. For example, during **explicit setup only**:

```python
import asyncio
import os
from psycopg import AsyncConnection
from loopiter.postgres import migration_sql


async def setup():
    # SQL contains its own BEGIN/COMMIT; execute on a standalone autocommit connection.
    async with await AsyncConnection.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        await conn.execute(migration_sql())


if __name__ == "__main__":
    asyncio.run(setup())
```

Runtime application:

```python
import asyncio
import os
from psycopg_pool import AsyncConnectionPool
from loopiter import FeedbackLoop
from loopiter.postgres import PostgresStore


async def main():
    async with AsyncConnectionPool(os.environ["DATABASE_URL"], open=False) as pool:
        await pool.wait()
        loop = FeedbackLoop(store=PostgresStore(pool), namespace="support/dev")
        await loop.record_execution(kind="prediction", input={"text": "Synthetic check"})
        await loop.close()  # Does not close your pool; its context manager does.


if __name__ == "__main__":
    asyncio.run(main())
```

Use TLS, timeouts, least-privilege DB credentials, backups and restore drills. The
adapter uses one checked-out connection per transaction and namespace advisory
locking across independent clients/processes. Follow [psycopg's async pool lifecycle](https://www.psycopg.org/psycopg3/docs/advanced/pool.html).
No transaction is held during evaluation or deployment callbacks. Avoid nested
store transactions, spawned tasks within a transaction, and direct SQL record
mutations. These bypass or interfere with the adapter's guarantees.

Python uses contract **v1**, `loopiter_python_records`, separate migration/version
tables and lock keys. Node uses its existing contract v2 and tables. **The languages
do not share records, hashes, active pointers, or deployment locks.** They can use
the same PostgreSQL database, but must not independently control the same external
target. Choose one language as lifecycle owner and communicate through your own
application API if both languages participate in a single workflow. This alpha
does not provide a wire protocol, cross-language migration, or a shared service.

## Evaluate, approve, deploy

1. Analyze scored evidence with `await loop.analyze(dimensions=[...])`.
2. Create an immutable proposal with `await loop.create_candidate(target={"kind":
   "prompt", "key": "support"}, proposed_change={...}, evidence={...}, risk="low")`.
   Your application proposes it, using its own model or deterministic logic.
3. `evaluate_candidate(id, evaluator, evaluator_name=..., version=..., dataset_hash=...)`
   calls your async `evaluator(candidate, cancellation_event)` outside the transaction.
   It must return `{"passed": bool, "metrics": {"name": finite_number}}`. Your evaluator
   must enforce independent holdout/guardrail thresholds; Loopiter does not invent them.
4. After human review, call `approve_candidate(id, actor=..., evaluation_id=...)` with
   the exact latest passing evaluation's ID. Failed or stale evaluations cannot approve.
5. Explicitly call `deploy_candidate(id, adapter, expected_artifact_version=...)`.
   Omit the initial version only when your infrastructure really has no existing artifact.
6. Use `rollback_candidate(id, adapter)` to restore its explicit predecessor/version.

Candidate IDs are insert-idempotency keys, not automatic semantic deduplication. For
proposal deduplication choose a stable ID derived with `fingerprint({...})` from the
target, proposed change, evidence fingerprint, evaluator version and dataset hash.
Changed evidence/evaluator versions should produce a new ID. No callback runs
automatically after feedback capture. No Python controller or unattended auto-apply
ships in this first alpha.

## Deployment and recovery contract

`DeploymentAdapter` exposes async `apply(request)`, `inspect(request)`, and
`rollback(request)`. Each request contains `attempt`, `candidate`,
`restore_candidate` (or `None`), stable `idempotency_key`, and a cooperative
`cancellation` event. Your adapter must durably record attempt IDs, compare the
expected artifact version atomically, implement real rollback, and fence late calls.

Apply and rollback return:

```python
receipt = {
    "attempt_id": request["attempt"]["id"],
    "artifact_version": "new-version",  # Or None only when rollback removes an artifact.
    "previous_artifact_version": "old-version",  # Or None when genuinely absent.
}
```

Inspection returns `{"status": "applied", "receipt": receipt}`, `{"status": "unknown"}`,
or `{"status": "not_applied"}`. **not_applied means fenced**: an earlier operation
cannot still complete later. A temporary absence or HTTP timeout is not proof.

Loopiter persists the attempt before the external change, then atomically finalizes
receipt, lifecycle events, candidate states and the active pointer. Ambiguous outcomes
stay pending and block the target. On `LoopiterError` with code `deployment_pending`,
use `error.attempt_id` with `reconcile_deployment(attempt_id, adapter)`. On process
restart or task cancellation, paginate `loop.list("attempts")` and reconcile pending
attempts. Reconciliation only inspects; it never blindly repeats apply or rollback.
An unknown inspection stays pending. Repeated rollback cannot revive a rolled-back
version. This is not universal exactly-once execution.

Cancel a running SDK operation with `task.cancel()`. Cancellation/timeout discards
late callback results; it cannot sandbox code, kill a process or undo an external
change. Async callbacks must cooperate and must not block the event loop. Database
deadlines remain application-owned. `deployments_enabled=lambda: False` blocks new
applies, but rollback/reconciliation remain available. Pending attempts and lifecycle
events are available through paginated `list`; no logger, daemon, or scheduler is installed.

## Analysis semantics

Separate `execution_window` and `observation_window` (inclusive `from`, exclusive `to`)
allow a later outcome to score an older execution. Include older executions explicitly
when narrowing the cohort. Default scoring recognizes numeric/boolean values and
success/failure words. Supply a finite-valued synchronous `score(signal)` and a
`scoring_version` for custom semantics. Conflicting corrections remain separate
evidence; they are never silently promoted to trusted labels.

Episodes are scoring units where available; otherwise executions are units. Signals
deduplicate by ID within a unit; one episode outcome is not counted once per turn.
Zero-confidence or unscored signals do not add effective support or recurrence.
Counts are descriptive, not calibrated probabilities. Evidence includes a versioned
fingerprint of scored values, execution revisions, baseline and scoring version.
Default maximum is 20,000 executions and 20,000 signals per analysis; exceeding it
raises an explicit error. Pages max at 1,000. Analysis materializes that bounded
snapshot in memory; it is not a streaming warehouse engine.

## Scope and release checks

Python includes capture, updates, structured analysis, manual candidate lifecycle,
timeouts/cancellation, events, namespace deletion, an in-memory dev store, optional
PostgreSQL 16/17 adapter, conformance tests and an offline end-to-end example.
The Node controller/experimental auto-apply, JsonFileStore/legacy migration CLI,
and OpenAI/Azure classification starter remain **Node-only**. Neither SDK automatically
fine-tunes a model. Application callbacks, database permissions and deployment
fencing remain application responsibilities.

From the repository root:

```sh
python -m pip install './python[dev,postgres]'
python -m unittest discover -s python/tests -v
ruff check python scripts/python-package-smoke.py
ruff format --check python scripts/python-package-smoke.py
python -m build python
twine check python/dist/*
python scripts/python-package-smoke.py
```

Set `LOOPITER_PYTHON_TEST_DATABASE_URL` only to a disposable PostgreSQL database;
integration tests explicitly migrate and delete only their randomly named test
namespaces. CI runs Python 3.11–3.14 against PostgreSQL 16/17. Maintainers publish
through the manual `python-publish.yml` workflow with an exact version/commit,
all validation jobs passing, and the protected `pypi` environment approved. The
uploaded wheel/sdist are the same artifacts installed in clean-consumer tests.
Trusted Publishing uses short-lived GitHub identity; no release credentials belong
in this repository. See the [release procedure](https://github.com/SanaanKhalid/loopiter/blob/main/docs/python-release.md).

[Security reporting](https://github.com/SanaanKhalid/loopiter/security/advisories/new)
· [Canonical docs](https://loopiter.docs.buildwithfern.com/get-started/overview)
