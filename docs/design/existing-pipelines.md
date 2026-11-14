# Integration kit for existing pipelines

Design only. No release. One implementation pull request per letter, in the order below.

Teams that already run a production AI service, in Python or Node, on a serverless function or a worker, should connect that service to Loopiter without replacing their feedback store, evaluator, or release process. A merge request plus CI is the reference release process. Names below are synthetic. No customer, company, or industry is assumed.

## What already exists

Surveyed from `src/` and `python/src/loopiter/`. The hosted console is a separate product. This repository is the SDK.

| Piece | Today |
| --- | --- |
| Capture | `FeedbackLoop.recordExecution` / `record_execution` and `completeExecution` / `complete_execution`. Caller may set `startedAt` / `completedAt`. `parentExecutionId` must share the episode. Same id plus the same input hash returns the existing row; a different payload is a conflict. |
| Versions on a call | `artifacts` may name `model`, `prompt`, `dataset`, `router`, and `policy`. There is no separate config fingerprint, stage id, or usage field on the execution. |
| Observer | Node `createObserver` wraps a function, records a pending execution, then completes or fails it. Streams stay lazy and are not buffered. Telemetry defaults to fail-open; a caller-supplied id is claimed before the function runs and is never a cache. `replayEligible` is stored as false. The call awaits the store write. There is no queue limit, write deadline, drop counter, or shutdown flush. Python has no observer. |
| Privacy | Capture modes `full`, `redacted`, and `metadata-only`. Redaction is conservative, not anonymization. `full` is explicit consent. |
| Signals | `recordSignal` / `record_signal` with `observedAt`, optional `executionId`, and a required `source`. A signal episode must match its execution. |
| Modes | `observe`, `recommend`, `experiment`, `autonomous`. On main, a controller with no mode is autonomous and self-improving. The published `0.3.0-alpha.1` / `0.3.0a1` packages still default to recommend. `observe` does not propose. `recommend` stores proposals and does not apply. `experiment` audits and does not deploy. Autonomous still fails closed without an audit partition and a budget. |
| Controller | `ImprovementController` in both languages. One tick is one phase. The application owns the schedule. Callbacks are not sandboxed. An ambiguous optimizer call is not replayed. |
| Deployment | `DeploymentAdapter` is `apply`, `inspect`, and `rollback`. An attempt is saved as `pending` before the external call. `unknown` stays pending. `not_applied` means the attempt is fenced and cannot take effect later. Rollback restores the recorded predecessor, not whatever is newest. Out-of-band drift is not overwritten. |
| Worker | `loopiter worker` imports the application and ticks. `--disable` returns before import. `LOOPITER_DISABLE` also pauses `tick()` inside an already running process. Rollback of an active canary still runs when the controller is recovering. |
| Evaluation | The controller's `evaluate` callback scores a frozen dataset. Audit rows are reserved when sent. A custom audit must match the frozen hash. There is no submit/status job protocol for an external harness. |
| Historical rows | The store has a `historical` collection. Importing it does not attach those rows to a live release. |
| Older recipe API | `SelfImprovementController` is the deprecated path. Its default is not the autonomous default. New work uses `ImprovementController`. |

## Autonomous default

Examples in this kit set `mode` explicitly. They start on `recommend` or `experiment`.

Autonomous mode is not implied by installing the SDK or by importing history. It is allowed only when all of these exist for that target:

- a recorded baseline artifact version
- a held-out set that the proposer did not write
- a real evaluator job that can fail
- a release adapter that can inspect and roll back

Until then, a tick may store proposals or audit results. It must not apply.

## Build order

a, then b, then c, then f, then d and g together, then e. Each letter is its own pull request. Later letters may stub an interface from an earlier letter. They do not ship that letter's behavior early.

## (a) Capture client and batch importer

**Exists.** Node observer and both `recordExecution` APIs, as above. Python has the record API only. Dropped writes are not a concept yet: a failed write is either swallowed (fail-open) or thrown (fail-closed), and the function still runs except when a durable id must be claimed first.

**Build.** Two surfaces, same record contract.

1. A Python capture client with the same opt-in bounded async path planned for the Node observer.
2. A log or queue batch importer in both languages.

Bounded async capture, opt-in, both SDKs:

- A fixed queue limit and a write deadline.
- Counters for dropped, failed, and backlog.
- Flush on shutdown, with the same deadline.
- The request path does not await the store.
- A dropped or failed record is gone. It is not replayed and it is not retried as a second business call.
- `replayEligible` stays false for live capture.

Importer, both SDKs, matching the platform ingestion contract:

- Original timestamps are kept. They are not replaced with import time.
- Operational status is one of `success`, `partial`, `error`, `abstained`, `dropped`.
- Stage lineage is `parentId` plus `stageId`.
- Served versions are prompt, model, and config. Missing config is absent, not guessed.
- Usage is `known`, `estimated`, or `unknown`. Unknown is never stored as zero.
- An idempotency key. The same key and same body is a no-op. The same key and a different body is a visible conflict.
- Out-of-order and multi-batch delivery are normal. The row is complete when its status is terminal, not when the batch happens to arrive.
- `replayEligible` plus a reason. Default is not eligible. Historical and imported rows never attach to the release that is serving now.

**API sketch.**

```text
observe(name, fn, context) -> result          # request path returns without waiting
capture.stats() -> { dropped, failed, backlog }
capture.flush(deadline) -> void

importBatch(records) -> { accepted, conflicts, rejected }
record:
  idempotencyKey, occurredAt, status,
  parentId?, stageId?,
  versions: { prompt?, model?, config? },
  usage: { state: known | estimated | unknown, tokens? },
  replay: { eligible: bool, reason }
```

**Lives in.** The clients and the importer library live in the SDK, writing to the application store. The same JSON body is what the platform ingestion API accepts. The platform does not get a second schema.

**Acceptance.** A handler under load returns before the store write. Overflow increments `dropped` and does not block. Shutdown flush stops at the deadline and counts the rest as dropped. Re-importing a batch is idempotent. A changed body conflicts. An imported row's `occurredAt` is the source time. Its release pointer is empty. Usage `unknown` is not `0`. A `dropped` status in a batch is stored as a tombstone, not executed.

## (b) Outcome-join kit

**Exists.** A signal may point at an `executionId`. The analyzer counts corrections. Nothing maps an external document id, item id, or category id onto an execution. Nothing classifies an edit as factual or stylistic. Late signals are not pinned to the release that served the original call.

**Build.** A small join library in both SDKs.

- Map external ids to one execution. One external id, two executions, is a visible conflict, not a silent pick.
- Backfill from a historical export. Backfill uses the importer in (a), so those rows stay off the current release.
- Record reviewer provenance: who, when, and the source system. The SDK does not authenticate that person.
- Classify an edit as `factual` or `stylistic`. Only `factual` can become a scored outcome.
- A late outcome stores the execution's served versions, not the versions running at join time.

**API sketch.**

```text
join(externalId, kind, executionId) -> link | conflict
backfill(batch) -> import result
recordEdit(executionId, { kind: factual | stylistic, value, reviewer, observedAt })
```

**Lives in.** SDK library. A review screen, if any, is platform UI on top of the same records.

**Acceptance.** Two writers racing the same external id produce one conflict row and no double score. A stylistic edit is stored and excluded from evaluation. A factual outcome scored a week later still names the prompt, model, and config that served the call. Backfill does not change today's serving fingerprint.

## (c) Own-evaluator adapter

**Exists.** `evaluate` is an in-process callback over a frozen example list. The controller hashes that dataset. A timed-out audit stays reserved. There is no external job.

**Build.** An adapter the team's harness implements. The SDK submits work and polls. It does not grade.

- `submit`, `status`, `cancel`, `resume`.
- Each case result names the frozen dataset hash.
- A failed, cancelled, or unknown job is not a pass. Missing cases are not a pass.
- Resume continues the same job id. It does not open a second job that could pass on a subset.

**API sketch.**

```text
submit({ datasetHash, cases, candidateHash }) -> { jobId }
status(jobId) -> pending | failed | unknown | { passed, cases[], datasetHash }
cancel(jobId) -> void
resume(jobId) -> status
```

**Lives in.** The protocol and the controller binding live in the SDK. The harness process is the team's. The platform may display job status. It does not decide `passed`.

**Acceptance.** A fixture job that returns `unknown` cannot move a candidate to approved. A hash mismatch rejects the result. Cancel then resume returns the original job, not a new pass. Node and Python accept the same status JSON.

## (f) Python replay-worker bridge

**Exists.** The worker imports `create_integration` and ticks. It does not call a product function with frozen inputs. Node has no replay runner either. Live capture marks `replayEligible: false`.

**Build.** A Python helper, with a Node twin in the same pull request, that calls one application function.

- Inputs are the frozen execution input.
- External actions are disabled. The bridge passes a guard object. Network, write, and enqueue helpers the app uses for side effects must check that guard and refuse.
- The guard is not a sandbox. It is a contract the function implements. A function that ignores it is out of scope.
- Only rows with `replay.eligible` true and a reason that this kit allows (`imported-for-regression` is the first reason) may be replayed.
- Replay writes a new execution whose parent is the source id. It does not overwrite the source and does not attach to the current release.

**API sketch.**

```text
replay(fn, execution, *, sideEffects: Guard) -> output
Guard.refuse(name) -> raises
```

**Lives in.** SDK. The platform does not run the team's function.

**Acceptance.** A synthetic function that would post a message raises when the guard is on, and the source row is unchanged. A row with `eligible: false` is refused before the function is called. The same fixture passes in Node.

## (d) Task evaluator templates and (g) synthetic quickstarts

Shipped together. Templates without a runnable path are not done. Examples without the metric are not done.

**Exists.** The controller compares numeric case scores with a paired bound. Policies can name a minimum improvement and guardrails. There is no template for recall, rank, field overlap, translation quality, groundedness, or summary faithfulness.

**Build.** Six versioned templates. Each template is a pure function from frozen cases to metrics, plus a policy fragment. Domain metrics replace plain accuracy.

| Task | Metric | Synthetic fixture |
| --- | --- | --- |
| Classification | Recall of each label, and a floor. A label under the floor fails even if overall accuracy is high. | Twenty short texts, three labels, one rare label. |
| Candidate matching | A ranking metric on ordered ids. | Ten queries, five candidates each, one relevant id. |
| Structured extraction | Field-level F1. Missing a required field fails the case. | Records with name, amount, and date fields. Values are fake. |
| Translation | A quality score with a floor, not an exact string match. | Eight sentence pairs in two invented glosses. |
| Grounded generation | Groundedness: every claim cites a provided span, or the case fails. | A paragraph and three claims, one unsupported. |
| Audio to summary | Coverage of required points and faithfulness. Extra claims that are not in the source fail. | A transcript of a one-minute note. No audio file is required. |

**API sketch.**

```text
template(task).score(cases) -> { metrics, passed }
template(task).policy({ floor }) -> policy fragment
```

**Lives in.** SDK, next to the evidence helpers. The platform may chart the metrics. It does not reimplement them.

**(g) Quickstart.** One directory per task. A reader with the SDK installed follows a single page and finishes in about fifteen minutes: load the fixture, score a bad candidate, score a good one, see the floor fail and the floor pass. No model call. No network. Mode is set in the file.

**Acceptance.** Each template's bad fixture fails for the stated metric, not for a generic accuracy drop. Each quickstart's commands are the ones in the page. Node and Python numbers match on the same fixture JSON.

## (e) Release-tracking adapter

**Exists.** Pending attempts, inspect, fenced `not_applied`, receipts, and predecessor rollback. No merge-request client. No CI status reader.

**Build.** An adapter that follows one candidate through the team's existing release process. GitLab is the first client. The states are generic: candidate, review request, checks, approval, apply, serving fingerprint.

- Opening a review request is not apply. Apply happens only when the pipeline records the serving fingerprint.
- The adapter implements `DeploymentAdapter`. The first call stores `pending`. A later tick `inspect`s. It does not open a second review request.
- Drift: the fingerprint on the serving target differs from the receipt. The attempt stays unresolved until a person reconciles. The adapter does not overwrite the target.
- Rollback lineage is the SDK predecessor. The adapter calls `rollback` only for that recorded version.
- Approval in the review system is recorded as provenance. It is not a substitute for the evaluator's `passed`.

**API sketch.**

```text
track(candidate) -> { reviewId }
inspect(attempt) -> applied { fingerprint } | unknown | not_applied
servingFingerprint() -> string
```

**Lives in.** SDK adapter. Tokens and project ids are application configuration. The platform is not required to merge or deploy.

**Acceptance.** A fake review server: create, fail CI, pass CI, apply, then change the fingerprint. Fail CI becomes `not_applied` and can be retried only as a new attempt. Pass CI without a fingerprint stays `unknown`. A drifted fingerprint does not auto-roll back. An explicit rollback restores the predecessor fingerprint and no other.

## Node and Python parity

Every letter ships both languages in that letter's pull request, except where a host API does not exist. The batch body, join conflict, job status, template metrics, and release inspect result are one JSON shape. Python adds the capture client it lacks. Node gains the bounded queue in the same pull request as Python, so the two observers do not diverge. Names stay camelCase in Node and snake_case in Python. Behavior does not.

## Security and privacy

- Context comes from the service, not from a caller-supplied form field.
- Default capture for these examples is `metadata-only` or `redacted`. `full` is opt-in.
- Idempotency conflicts are visible. They are not merged.
- Dropped capture is not reconstructed.
- Imported history is not labeled as the current release.
- The replay guard is a function contract, not isolation. Do not point it at a function that can ignore the guard.
- Reviewer ids are provenance, not authorization.
- Release tokens stay in the application's secret store. The SDK does not log them.
- A failed or unknown evaluator job cannot approve a candidate.

## Non-goals

- Replacing the team's model, queue, or CI.
- Training, fine-tuning, or writing prompts from logs.
- A hosted scheduler or a daemon inside the SDK.
- Turning autonomous mode on because a batch imported cleanly.
- Sandboxing arbitrary application code.
- Treating stylistic edits as labels.
- Inventing token counts.
- A second tracing provider.

## Open questions

- Queue limit and write deadline defaults, and whether shutdown beyond the deadline should fail the process or only the counter.
- Which `replay.reason` values are eligible besides regression import.
- Whether field-level F1 and the translation score live in the SDK or call a library the application already pins.
- How the GitLab client should behave when two pipelines report different fingerprints for one attempt.
- Whether the platform ingestion API is the only remote sink, or whether the SDK importer also writes the local store in production. This design requires both to accept the same body. It does not require teams to use the platform.
