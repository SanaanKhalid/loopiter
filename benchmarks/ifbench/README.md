# IFBench benchmark

Internal comparison of a frozen system prompt, a one-shot rewrite, and the
autonomous `ImprovementController`. Results are internal. Do not publish them,
attach them to a release, or commit them.

This module does not change `benchmarks/kb-qa`.

## Data and licenses

| Split | Source | Revision | License |
| --- | --- | --- | --- |
| Held-out | Hugging Face `allenai/IFBench_test` (about 300 rows) | `ed7c12452594b7028b15807b86d3938150b663ae` | ODC-BY-1.0 |
| Optimization, validation, audit, production | Hugging Face `allenai/IF_multi_constraints_upto5` | `2e3a77407b7fce69f95b248d64a884e3ae1c2423` | ODC-BY-1.0 |

The train set is the IF-RLVR data with up to five constraints per instruction,
sampled from IFEval and IFBench train constraints. Its card uses the same
ODC-BY-1.0 license as the test set. It also says the rows include output from
third-party models that stay under those models' own terms, and that use should
follow Ai2's responsible-use guidance. Attribute Allen Institute for AI.

The official test set is the held-out split. It is never placed in the dataset
snapshot and never passed to `propose` or `evaluate`. Pool rows are shuffled
per seed. The five seeds are 1 through 5. Sizes are optimization 150,
validation 150, audit 300, production observation 150, and the official test
set as held-out.

## Fetch

The fetch script writes a gitignored cache. It does not run in CI (`CI=true`
refuses it). Tests use the checked-in synthetic fixtures.

```sh
python -m pip install pyarrow
python benchmarks/ifbench/fetch.py
```

## Verifier

Scoring calls the official IFBench checkers from the `ifbench` package pinned
to git commit `cd189a9c2889526d8af901d2103fd3e1ffcea6df` of
[allenai/IFBench](https://github.com/allenai/IFBench) (Apache-2.0). Node keeps
one Python process open and speaks JSON lines to `bridge.py`. Strict and loose
follow `evaluation_lib.py` at that commit. The package is not in the wheel's
eval helper, so the bridge imports `ifbench.instructions_registry` and applies
that file's strict and loose response variants. Null kwargs are dropped before
both modes.

```sh
python -m pip install -r benchmarks/ifbench/requirements.txt
```

The first import downloads NLTK data into the package directory. CI installs
this requirements file in the offline benchmark job and does not download the
datasets.

Primary metric: strict prompt-level accuracy. The report also includes loose
prompt-level accuracy and instruction-level accuracy, strict and loose.
The proposer receives per-instruction strict pass/fail from that verifier
before the single rewrite call.

## Artifact and generation

The artifact is one versioned system prompt, `ifbench-system-v1`. The character
cap is 8000 Unicode code points. The kb-qa fragment cap is 800, which is too
small for an instruction-following prompt. 8000 matches the packaged
prompt-example fragment limit and is large enough for a constraint-following
system prompt while staying inside the provider input budget.

Predict output is free-form text in a strict JSON `{ "text" }` field, because
the existing Azure Responses client only accepts a JSON schema. `max_output_tokens`
must be from 1024 to 2048. The default is 1024. Propose defaults to 2048 so a
prompt at the character cap can be returned. Override either bound with
`LOOPITER_BENCH_PREDICT_MAX_OUTPUT_TOKENS` or
`LOOPITER_BENCH_PROPOSE_MAX_OUTPUT_TOKENS`.

## Arms

1. Frozen baseline. The checked-in prompt is scored and not rewritten.
2. One-shot rewrite. The same propose call runs once and the result is served
   with no validation, audit, or observation gate.
3. Autonomous controller. `ImprovementController` with `mode: "autonomous"` and
   `selfImproving: true`. Validation, the paired Hoeffding audit, and
   production observation all run.

The report records the served held-out score and the ungated proposal's
held-out score, with seed bootstrap intervals. A harmful candidate is injected
in the offline mock. The validation gate must reject it. That check uses the
product `minimumImprovement` of 0.05 even when the comparison flag is different.

## minimumImprovement

The flag `--minimum-improvement` defaults to 0.05, the product onboarding
value. It is stored on the report. It is not lowered in code.

At 300 audit rows, alpha 0.05, and a score range of 0 to 1, the paired
Hoeffding lower bound needs an observed gain of about 19 percentage points
before it clears 0.05. A smaller real gain is rejected and the served artifact
stays the baseline. The ungated score still shows what the proposal would have
scored.

## Commands

Offline mock on the fixtures, no network and no paid calls:

```sh
npm run build
node dist/benchmarks/ifbench/run.js --fixtures --seeds 1
```

Estimate, no provider call. Set input and output prices. This prints the
smoke plan (1 seed, 30 rows per split) and the full plan for the three arms:

```sh
LOOPITER_BENCH_PRICE_INPUT_PER_1M=1 \
LOOPITER_BENCH_PRICE_OUTPUT_PER_1M=2 \
node dist/benchmarks/ifbench/run.js --estimate
```

Both datasets in one process:

```sh
node dist/benchmarks/public/estimate-main.js
```

Live Azure calls need `--live` and `LOOPITER_BENCH_ALLOW_LIVE=1`, plus the
same price, cap, and credential variables as `benchmarks/kb-qa`. The key is
not logged or written. `--smoke` is 1 seed and 30 rows per split. The spend
ledger is `reports/ifbench-live/ledger.json`.
