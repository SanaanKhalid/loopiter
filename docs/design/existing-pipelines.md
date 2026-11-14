# Integration kit for existing pipelines

Design only. No release. One implementation pull request per letter, except (d) and (g), which ship in one pull request.

Teams that already run a production AI service, in Python or Node, on a serverless function or a worker, should connect that service to Loopiter without replacing their feedback store, evaluator, or release process. A review request plus CI is the reference release process. Names below are synthetic. No customer, company, or industry is assumed.

## What already exists

Surveyed from `src/` and `python/src/loopiter/`. The hosted console is a separate product. This repository is the SDK.

| Piece | Today |
| --- | --- |
| Capture | `FeedbackLoop.recordExecution` / `record_execution` and `completeExecution` / `complete_execution`. Caller may set `startedAt` / `completedAt`. `parentExecutionId` must share the episode. Same id plus the same input hash returns the existing row; a different payload is a conflict. |
| Versions on a call | `artifacts` may name `model`, `prompt`, `dataset`, `router`, and `policy`. There is no separate config fingerprint, stage id, or usage field on the execution. |
| Observer | Node `createObserver` wraps a function, records a pending execution, then completes or fails it. Streams stay lazy and are not buffered. Telemetry defaults to fail-open; a caller-supplied id is claimed before the function runs and is never a cache. `replayEligible` is stored as false. The default call awaits the store write. Opt-in `bounded` capture queues writes with a limit, a write deadline, dropped/failed/backlog counters, and a shutdown flush. That mode does not await the store, and a durable id is claimed only by the queued write. Dropped and failed records are not replayed. `queueLimit` is at least 2. `shutdown` drains admitted writes; anything still unfinished at the timeout is counted and reported. An open `forceFlush` does not abandon an in-flight write. Python `create_observer` follows the same bounded rules, and `with_loopiter` sends its writes through that client. |
| Privacy | Capture modes `full`, `redacted`, and `metadata-only`. Redaction is conservative, not anonymization. `full` is explicit consent. |
| Signals | `recordSignal` / `record_signal` with `observedAt`, optional `executionId`, and a required `source`. A signal episode must match its execution. |
| Modes | `observe`, `recommend`, `experiment`, `autonomous`. On main, a controller with no mode is autonomous and self-improving. The published `0.3.0-alpha.1` / `0.3.0a1` packages still default to recommend. `observe` does not propose. `recommend` stores proposals and does not apply. `experiment` audits and does not deploy. Autonomous still fails closed without an audit partition and a budget. |
| Controller | `ImprovementController` in both languages. One tick is one phase. The application owns the schedule. Callbacks are not sandboxed. An ambiguous optimizer call is not replayed. |
| Deployment | `DeploymentAdapter` is `apply`, `inspect`, and `rollback`. An attempt is saved as `pending` before the external call. `unknown` stays pending. `not_applied` means the attempt is fenced and cannot take effect later. Rollback restores the recorded predecessor, not whatever is newest. Out-of-band drift is not overwritten. |
| Worker | `loopiter worker` imports the application and ticks. `--disable` returns before import, so a disabled worker does not observe or roll back. An in-process `tick()` that sees `LOOPITER_DISABLE`, or a controller with `selfImproving: false`, still observes and recovers an active canary. |
| Evaluation | The controller's `evaluate` callback scores a frozen dataset. Audit rows are reserved when sent. A custom audit must match the frozen hash. There is no submit/status job protocol for an external harness. |
| Historical rows | The store has a `historical` collection. Importing it does not attach those rows to a live release. |
| Provider capture | Python `loopiter.integrations.openai.with_loopiter` wraps an `AsyncOpenAI` client and records `chat.completions.create` and `responses.create`, including streams, as executions. Node has the matching OpenAI wrapper. Neither is a generic function observer, and both await the store write. |
| Older recipe API | `SelfImprovementController` is the deprecated path. Its default is not the autonomous default. New work uses `ImprovementController`. |

## Autonomous default

Examples in this kit set `mode` explicitly. They start on `recommend` or `experiment`.

On main, a controller with no mode is already autonomous. The SDK already refuses that mode without an audit partition and a budget. It does not require a release adapter that can inspect and roll back. This kit does not add that gate.

The four checks below are a rule for this kit's examples, not a new controller behavior:

- a recorded baseline artifact version
- a held-out set that the proposer did not write
- a real evaluator job that can fail
- a release adapter that can inspect and roll back

An example stays on `recommend` or `experiment` until those exist. Importing history does not switch it to autonomous.

## Build order

a, then b, then c, then f, then d and g together, then e. One pull request per letter, except (d) and (g), which ship in one pull request. (e) lands the provider-neutral release-tracking interface and a fake implementation first. GitLab and GitHub are the first real clients of that interface, in that same pull request. Neither client is a prerequisite for the other. Later letters may stub an interface from an earlier letter. They do not ship that letter's behavior early.

## (a) Capture client and batch importer

**Exists.** Node `createObserver` and Python `create_observer`, both `recordExecution` APIs, and `importBatch` / `import_batch`. `with_loopiter` captures `AsyncOpenAI` calls and sends those writes through the Python capture client. The default path in both languages still awaits each write: a failed write is either swallowed (fail-open) or thrown (fail-closed), and the function still runs except when a durable id must be claimed first. Opt-in bounded capture can drop a write; that record is not replayed. The importer stores historical rows and does not run the application.

**Build.** Two surfaces, same record contract.

1. A Python capture client with the same opt-in bounded async path planned for the Node observer. `with_loopiter` stays the OpenAI facade and sends its writes through that client. It is not replaced, and it is not a second write path.
2. A log or queue batch importer in both languages. The record schema in this document is the source of truth. Any ingestion endpoint accepts that body. There is no schema defined outside this repository.

Bounded async capture, opt-in, both SDKs:

- A fixed queue limit and a write deadline.
- Counters for dropped, failed, and backlog.
- Flush on shutdown, with the same deadline.
- The request path does not await the store.
- A dropped or failed record is gone. It is not replayed and it is not retried as a second business call.
- `replayEligible` stays false for live capture.

Importer, both SDKs, using the record schema in this document (the platform ingestion API will implement this schema):

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

**Lives in.** The clients and the importer library live in the SDK, writing to the application store. The schema in this document is the source of truth. A platform ingestion endpoint, if used, accepts that same body. It does not define a second schema.

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

**Exists.** The worker imports `create_integration` / `createIntegration` and ticks. It does not call a product function with frozen inputs. Node has no replay runner either. Live capture marks `replayEligible: false`.

**Build.** A Python helper, with a Node twin in the same pull request, that calls one application function. (f) does not change the existing project and does not need write access to it. The only new file is the team's integration module, the same `create_integration` / `createIntegration` file the worker already loads.

- Inputs are the frozen execution input.
- Guarding happens only in that integration module. The bridge is given stub or fake clients for network, storage, and queue. Those stubs are constructed in the integration module and passed in. The application's own helpers are not edited.
- A function that cannot take those injected clients cannot be replayed. The bridge refuses it. It does not ask anyone to modify the function.
- Only rows with `replay.eligible` true and a reason that this kit allows (`imported-for-regression` is the first reason) may be replayed.
- Replay writes a new execution whose parent is the source id. It does not overwrite the source and does not attach to the current release.

**API sketch.**

```text
replay(fn, execution, *, clients: { network, storage, queue }) -> output
```

The integration module builds `clients` from stubs. `fn` is the existing function only when it already accepts those clients. Otherwise replay is refused before `fn` is called.

**Lives in.** SDK. The platform does not run the team's function. The integration module is application-owned and sits beside the existing project. It does not patch it.

**Acceptance.** With stub clients, a synthetic function returns the frozen output and the stubs record no send, write, or enqueue. The source row is unchanged. A function that cannot accept injected clients is refused, and the existing project is not modified. A row with `eligible: false` is refused before the function is called. The same fixture passes in Node.

## (d) Task evaluator templates and (g) synthetic quickstarts

Shipped together. Templates without a runnable path are not done. Examples without the metric are not done.

**Exists.** The controller compares numeric case scores with a paired bound. Policies can name a minimum improvement and guardrails. There is no template for recall, rank, field overlap, translation quality, groundedness, or summary faithfulness.

**Build.** Six versioned templates. Each template is a pure function from frozen cases to metrics, plus a policy fragment. Domain metrics replace plain accuracy.

The six tasks are a general catalog of common industry uses, not a customer list.

| Task | Metric | Synthetic fixture |
| --- | --- | --- |
| Ticket or document classification | Recall of each label, and a floor. A label under the floor fails even if overall accuracy is high. | Twenty support tickets, three labels, one rare label. |
| Record matching and dedup | A ranking metric on ordered ids. | Ten product listings, five candidates each, one matching id. |
| Structured field extraction | Field-level F1. Missing a required field fails the case. | Invoices with name, amount, and date fields. Values are fake. |
| Translation | A quality score with a floor, not an exact string match. | Eight news-article sentences in two invented glosses. |
| Grounded summarization or generation | Groundedness: every claim cites a provided span, or the case fails. | One news article and three claims, one unsupported. |
| Audio to summary | Coverage of required points and faithfulness. Extra claims that are not in the source fail. | A transcript of a short spoken product listing. No audio file is required. |

**API sketch.**

```text
template(task).score(cases) -> { metrics, passed }
template(task).policy({ floor }) -> policy fragment
```

**Lives in.** SDK, next to the evidence helpers. The platform may chart the metrics. It does not reimplement them.

**(g) Quickstart.** One directory per task. A reader with the SDK installed follows a single page and finishes in about fifteen minutes: load the fixture, score a bad candidate, score a good one, see the floor fail and the floor pass. No model call. No network. Mode is set in the file.

**Acceptance.** Each template's bad fixture fails for the stated metric, not for a generic accuracy drop. Each quickstart's commands are the ones in the page. Node and Python numbers match on the same fixture JSON.

## (e) Release-tracking adapter

**Exists.** Pending attempts, inspect, fenced `not_applied`, receipts, and predecessor rollback. No check-status reader. No serving-fingerprint reader.

**Build.** A provider-neutral interface, then a fake implementation, then GitLab and GitHub as the first real clients. Both implement `ReleaseClient`. Neither real client comes before the other. A team can use the interface with the fake or its own client and needs neither.

The default client is read-only. It reads check status and the serving fingerprint. It does not write to the team's repository.

The candidate is handed off as a patch or bundle. A person, or the team's own automation, submits it. Opening a review request (a merge request or a pull request) is optional. It runs only when the integration is given an explicit token for that write. Without that token, the adapter never opens one.

- Reading checks is not apply. Apply is recorded only when the serving fingerprint matches the candidate.
- The adapter implements `DeploymentAdapter` on top of the read-only client. The first call stores `pending`. A later tick reads status and the fingerprint. It does not open a second review request.
- Drift: the fingerprint on the serving target differs from the receipt. The attempt stays unresolved until a person reconciles. The adapter does not overwrite the target.
- Rollback lineage is the SDK predecessor. The adapter calls `rollback` only for that recorded version.
- Approval in the review system is recorded as provenance when it was read. It is not a substitute for the evaluator's `passed`.

**API sketch.**

```text
ReleaseClient (read-only):
  checks(candidateId) -> pending | failed | passed | unknown
  servingFingerprint() -> string | absent

handoff(candidate) -> patch | bundle

# optional; refused unless a token was explicitly supplied
openReview(candidate, token) -> { reviewId }
```

The fake client implements `ReleaseClient` in memory. GitLab and GitHub implement the same interface.

**Lives in.** SDK. Tokens, when used for the optional write, stay in application configuration. The platform is not required to merge or deploy.

**Acceptance.** With read-only credentials, handoff returns a patch, checks move from `unknown` to applied or `not_applied`, and the repository is not written. `openReview` without an explicit token is refused. The fake client covers that path before either real client is configured. Failed checks become `not_applied` and can be retried only as a new attempt. Passed checks without a fingerprint stay `unknown`. A drifted fingerprint does not auto-roll back. An explicit rollback restores the predecessor fingerprint and no other.

## Node and Python parity

Every letter ships both languages in that letter's pull request, except where a host API does not exist. The batch body, join conflict, job status, template metrics, and release inspect result are one JSON shape. Python adds the capture client it lacks. Node gains the bounded queue in the same pull request as Python, so the two observers do not diverge. Names stay camelCase in Node and snake_case in Python. Behavior does not.

## Security and privacy

- Context comes from the service, not from a caller-supplied form field.
- Default capture for these examples is `metadata-only` or `redacted`. `full` is opt-in.
- Idempotency conflicts are visible. They are not merged.
- Dropped capture is not reconstructed.
- Imported history is not labeled as the current release.
- Replay does not edit the existing project. Clients are stubbed in the integration module. A function that cannot take those stubs is refused.
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
- How a release client should behave when two checks report different fingerprints for one attempt. The fake client must show the chosen rule before GitLab or GitHub do.
- Whether a team also sends batches to a platform endpoint. The SDK schema in this document is the body either sink accepts. Using the platform is optional.
