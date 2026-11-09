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

`--live`, and the environment variable `LOOPITER_BENCHMARK_LIVE=1`, are refused.
This command never calls a provider.

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

## Phase 1 later

Phase 1 is not implemented and must not be started from this harness.

A later live run would:

- call a real provider, with the default model `gpt-5.4-mini`
- compare autonomous versus frozen only
- keep results internal (no publish, no release)
- read credentials from environment variables, never from the repo
- require explicit spend caps
- refuse to start unless someone has explicitly approved that run

Do not set provider keys for the Phase 0 command. `--live` exits with an error
and does not call a model.
