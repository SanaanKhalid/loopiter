# Offline benchmark

Phase 0 compares a **frozen baseline** (no improvement) with an **autonomous candidate**
on one synthetic task. The candidate is the SDK `ImprovementController` in
`autonomous` mode with `selfImproving: true`. Its normal validation, audit, and
observation gates decide whether a change is kept.

The harness makes no network calls and does not spend money. Model calls are
seeded mocks with fixed token footprints. A configurable price table turns those
tokens into simulated USD so a later run can plug in real rates.

Python has the same controller, but this harness is Node-only. A Python port of
the same protocol is a follow-up; it is not running in CI.

This directory is part of the repository. It is not included in the published
npm package.

## Task

Internal knowledge-base QA, in the same style as the autonomous prompt example.

- The artifact is a short KB fragment (`id=passage` lines). That fragment is the
  only thing the loop is allowed to change.
- Retrieval is a frozen keyword lookup. It does not read the artifact. A hit
  returns the named passage and a distractor. Near-miss facts are similar
  entities with different values (staff vacation versus contractor vacation).
  Multi-hop questions need two passages. Some questions miss retrieval or are
  out of scope; the fragment cannot make those correct.
- Train rows are the controller's optimization partition (the proposer sees these).
- Dev rows are the validation and audit partitions. Audit is a pre-deploy gate,
  not the final score.
- The held-out test split is scored only after the loop finishes. It is not passed
  to `dataset`, `propose`, or `evaluate`.

The mock proposer writes train labels into the passages a hit actually names.
It leaves misses and out-of-scope rows alone. The mock answerer reads those
passages, then sometimes slips. The slip is a seeded draw: same seed and
question always slip the same way, and a different seed does not. A slip uses
the distractor or returns only the first fact of a multi-hop question. Because
some rows are unfixable and the mock is imperfect, held-out success stays below
the ceiling. The rates are whatever that mixture produces.

Default seeds are 1 through 5. Latency and token bills are deterministic. The
per-seed success rates are not.

## Run locally

From the repository root, with Node.js 22 or 24:

```sh
npm ci
npm run benchmark:offline
```

That builds the SDK and runs five seeds. The process exits non-zero if the
regression check or the budget check fails.

Write a report:

```sh
npm run build
node dist/benchmarks/kb-qa/run.js --seeds 5 --out reports/offline-kb-qa.json
```

Useful flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--seeds` | `5` | Number of seeds, starting at `--seed-start` (default `1`) |
| `--per-run-usd` | `1` | Simulated cap for one arm of one seed |
| `--total-usd` | `5` | Simulated cap for the whole comparison |
| `--tolerance` | `0` | Allowed held-out drop below the baseline, in rate points |
| `--bootstrap` | `2000` | Bootstrap resamples |
| `--bootstrap-seed` | `17` | Bootstrap RNG seed |
| `--out` | stdout | JSON path. A `.md` summary is written beside it |

`--live` does not run unless `LOOPITER_BENCH_ALLOW_LIVE=1` is also set.
`LOOPITER_BENCHMARK_LIVE=1` alone is still refused. The Phase 0 command never
calls a provider. See [Phase 1](#phase-1-live-runbook) for the opt-in path.

Unit tests for the intervals, the spend ledger, and the check rules:

```sh
npm test
```

CI also runs the five-seed harness in the `offline-benchmark` job. A failed
regression check or budget check fails that job.

## How to read the report

The JSON file is the source of truth. The Markdown file is the same result in a
short table.

- `arms.baseline` is the frozen KB, scored on the held-out split.
- `arms.candidate` is whatever artifact is still served after the autonomous loop
  and its gates. Held-out scoring uses that served artifact.
- `heldOutSuccessRate` is the mean of the per-seed rates.
- `bootstrap` is the primary 95% interval. It resamples seeds with replacement and
  takes a percentile interval of the mean (linear interpolation between order
  statistics, the same index rule as NumPy's default percentile). The seed is the
  unit because seeds are the repeated runs. Seed rates differ, so the interval
  has width. An interval collapses to a point only when every seed rate is the
  same.
- `wilsonPooled` is a Wilson score interval on the pooled held-out trials, using
  z = 1.959963984540054. It treats items as i.i.d. Bernoulli trials. That is a
  convenience view of this balanced synthetic set, not a claim about production
  traffic.
- `spend` is simulated tokens times the price table, in integer micro-USD, plus
  the matching simulated latency. It is not a provider invoice. The placeholder
  table prices `gpt-5.4-mini` at $1 per million input tokens and $4 per million
  output tokens.
- `comparisonBudget.adhered` is true when the comparison stayed inside the
  configured caps.
- `passed` is true only when the comparison stayed inside its caps, both checks
  below passed, every autonomous seed finished in `completed`, and the candidate's
  mean held-out rate is above the frozen baseline. This synthetic task is expected
  to improve. A real loss on a later task would be reported the same way and would
  fail the process until the expectation is changed on purpose.

### Regression check

Two injected cases, both required:

1. A deliberately harmful KB (every passage wrong, including passages the baseline
   had right). The validation gate must reject it (`no_improvement` /
   `validation_failed`) so the served artifact stays the baseline. The report also
   scores that harmful fragment off to the side. That counterfactual held-out rate
   has to be worse than the baseline by more than the tolerance, otherwise the
   injection was not actually harmful. The served rate must stay within tolerance
   of the baseline.
2. A candidate that would pass offline gates, with production observation forced
   to fail. The observation guardrail must roll it back (`rolled_back` /
   `previous_version_restored`). The served version must be the baseline version,
   and served held-out success must stay within tolerance of the baseline.

Tolerance is an absolute rate. `0` means the served rate cannot be lower than the
baseline at all.

### Budget check

A separate pair of runs uses caps set from the mock price of a few calls:

- the per-run cap fits the proposal plus two answer calls
- the total cap fits one such run plus a proposal and one more answer call

The first run must stop on `per_run_cap`. The second must stop on `total_cap`.
Charged spend must stay at or under both caps, each run must refuse at least one
further call, and neither run may finish as `completed`. The loop stops because
the mock throws `spend_cap` before recording the call that would exceed the cap.

## Phase 1 live runbook

Phase 1 compares the same two arms as Phase 0, frozen baseline versus the
autonomous candidate, on the same splits. It calls Azure OpenAI through the
Responses API (`/openai/v1/responses`), which is the provider surface already
used by `AzureOpenAIProvider`. The deployment name defaults to `gpt-5.4-mini`.

Results are internal only. Do not publish them, attach them to a release, or
commit them. Reports and the spend ledger are written under `reports/kb-qa-live/`,
which is gitignored.

The default `benchmark:offline` command never calls a provider. A live process
starts only when both `--live` and `LOOPITER_BENCH_ALLOW_LIVE=1` are present.
Missing prices, caps, or credentials refuse the process before any request.
There are no baked-in prices or caps.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `LOOPITER_BENCH_ALLOW_LIVE` | live run | Must be `1` |
| `AZURE_OPENAI_ENDPOINT` | live run | HTTPS resource origin, no path and no credentials |
| `AZURE_OPENAI_API_KEY` | live run | API key. Never printed, logged, or stored |
| `AZURE_OPENAI_DEPLOYMENT` | no | Deployment name. Default `gpt-5.4-mini` |
| `AZURE_OPENAI_API_VERSION` | no | Query value. Default `v1` (the documented Azure OpenAI v1 Responses API) |
| `LOOPITER_BENCH_PRICE_INPUT_PER_1M` | live run and `--estimate` | USD per 1M uncached input tokens |
| `LOOPITER_BENCH_PRICE_OUTPUT_PER_1M` | live run and `--estimate` | USD per 1M output tokens |
| `LOOPITER_BENCH_PRICE_CACHED_INPUT_PER_1M` | live run | USD per 1M cached input tokens. Required because Responses usage can report them |
| `LOOPITER_BENCH_TOTAL_CAP_USD` | live run | Cumulative cap across invocations. A Phase 1 ceiling of 150 USD is the planned budget |
| `LOOPITER_BENCH_WARN_USD` | live run | Warn once when cumulative spend crosses it. A Phase 1 warning of 100 USD is the planned mark |
| `LOOPITER_BENCH_INVOCATION_CAP_USD` | live run | Cap for this process only |
| `LOOPITER_BENCH_REASONING_EFFORT` | no | `reasoning.effort` on each request. Default `low`. Accepted values: `none`, `minimal`, `low`, `medium`, `high`. `minimal` is for deployments that accept it. `omit` leaves the field off. Anything else refuses to start |
| `LOOPITER_BENCH_PREDICT_MAX_OUTPUT_TOKENS` | no | `max_output_tokens` for an answer. Default `256`. A finite integer greater than zero |
| `LOOPITER_BENCH_PROPOSE_MAX_OUTPUT_TOKENS` | no | `max_output_tokens` for a proposal. Default `1024`. A finite integer greater than zero |

Do not put the key in the shell history if that is a problem for you, and do
not echo it. The process redacts the key and `api-key` / `Authorization` header
values from errors. It does not log request headers.

### Estimate, then smoke, then the full run

`--estimate` prices the harness call plan and makes no provider calls. It does
not need a key, an endpoint, or the allow flag. It still needs the input and
output prices. It prints the smoke plan (1 seed, 14 rows in each split) and the
full plan (seeds 1–5, every row). Input tokens are `ceil(UTF-8 bytes / 4)` of
each request body, including `reasoning` when it is sent. Output tokens are the
`max_output_tokens` bound sent on that call (256 for an answer, 1024 for a
proposal, unless the output-bound variables override them). `--estimate` uses
those same bounds. The candidate side of the plan is
about 12× the baseline call count on the full split: one proposal, a paired
validation pass, a paired audit pass, production observation, and held-out
scoring.

```sh
LOOPITER_BENCH_PRICE_INPUT_PER_1M=0.75 \
LOOPITER_BENCH_PRICE_OUTPUT_PER_1M=4.5 \
node dist/benchmarks/kb-qa/run.js --estimate
```

Smoke is the same small plan, actually executed. It is meant to stay around
$5 or below at typical mini-model rates. Set the caps before either live
command. Example caps below are the planned Phase 1 budget, not defaults:

```sh
export LOOPITER_BENCH_ALLOW_LIVE=1
export AZURE_OPENAI_ENDPOINT=https://YOUR_RESOURCE.openai.azure.com/
export AZURE_OPENAI_API_KEY=...
export LOOPITER_BENCH_PRICE_INPUT_PER_1M=0.75
export LOOPITER_BENCH_PRICE_OUTPUT_PER_1M=4.5
export LOOPITER_BENCH_PRICE_CACHED_INPUT_PER_1M=0.075
export LOOPITER_BENCH_TOTAL_CAP_USD=150
export LOOPITER_BENCH_WARN_USD=100
export LOOPITER_BENCH_INVOCATION_CAP_USD=25
npm run build
node dist/benchmarks/kb-qa/run.js --live --smoke
node dist/benchmarks/kb-qa/run.js --live --seeds 5
```

`--rows N` caps every split at N rows. `--seeds N` limits how many seeds run,
starting at `--seed-start` (default 1). `--stop-at-warn` stops before the next
call once cumulative spend has reached `LOOPITER_BENCH_WARN_USD`. A normal run
prints a `WARN` line and records `warn.marker` in the report, then continues
until a hard cap.

Before each request the process prices a worst case: one input token per
request byte, plus the `max_output_tokens` bound, at the higher of the input
and cached prices. If that worst case would pass the total cap or the
per-invocation cap, the call is not sent and the report is partial. Every
attempt, including a retry, is added to the ledger. The ledger is
`reports/kb-qa-live/ledger.json`. A hold for the worst case is written before
the request and replaced with the usage from the response when the response
includes it. Failed attempts without usage keep the worst-case amount so a
retry cannot be free. Each request sets `max_output_tokens` and, unless
`LOOPITER_BENCH_REASONING_EFFORT=omit`, `reasoning.effort` (default `low`).
A reasoning model can spend the whole output bound before it emits the label
and return status `incomplete` with `incomplete_details.reason` of
`max_output_tokens`. The run stops and the report's `stopped.message` includes
that reason. It does not include headers or the API key. Use `minimal` when
the deployment accepts it, or raise the answer bound, if that happens. Each
request times out after 20 seconds and retries at most once on 408, 409, 429,
500, 502, 503, 504, or a transport timeout.

### Reset the ledger

Cumulative spend survives later invocations. To start a new budget, stop the
process and delete the ledger file:

```sh
rm -f reports/kb-qa-live/ledger.json
```

Deleting it resets the recorded total to zero. Do that only when you mean to.
A ledger file that cannot be parsed refuses to start, so a corrupt file is not
silently treated as zero spend.

The JSON report is the source of truth for a live run. `passed` is true only
when every seed finished in `completed`, both arms were fully scored, spend
stayed inside the caps, and the candidate's mean held-out rate is above the
frozen baseline. A stopped run is a failure with a partial report, not a crash
that drops the ledger.
