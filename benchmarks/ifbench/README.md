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

A few train keys are reused for different prompts. A key that appears once
stays the row id. A repeated key becomes `key-` plus the first 12 hex
characters of the SHA-256 of that prompt, so the id is unique and stable.
Test-set ids are the dataset keys and are left unchanged. Fetch and the cache
loader both refuse a cache whose train ids are still not unique. The manifest
records how many keys were repeated and how many rows were rewritten. At the
pinned train revision, 95,373 rows include four repeated keys
(`hard_coded_1`, `hard_coded_5`, `hard_coded_17`, `hard_coded_18`) across nine
prompts, and those nine ids are rewritten. The test split stays 300 rows.

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
datasets. Copyright and the Apache-2.0 text for the ported loose-response
variants are in [benchmarks/NOTICE](../NOTICE).

Primary metric: strict prompt-level accuracy. The report also includes loose
prompt-level accuracy and instruction-level accuracy, strict and loose.
The proposer receives per-instruction strict pass/fail from that verifier
before the single rewrite call. The example list is capped the same way as
HotpotQA: failures first, then a seeded shuffle, at most 8 examples, and a
16384-byte payload (`LOOPITER_BENCH_PROPOSE_EXAMPLES`,
`LOOPITER_BENCH_PROPOSE_BYTES`). Held-out rows are not included.

## Artifact and generation

The artifact is one versioned system prompt, `ifbench-system-v1`. The character
cap is 8000 Unicode code points. The kb-qa fragment cap is 800, which is too
small for an instruction-following prompt. 8000 matches the packaged
prompt-example fragment limit and is large enough for a constraint-following
system prompt while staying inside the provider input budget.

Predict output is free-form text in a strict JSON `{ "text" }` field, because
the existing Azure Responses client only accepts a JSON schema. `max_output_tokens`
must be from 1024 to 2048. The default is 2048. A reasoning model counts
reasoning tokens against that bound, and format-heavy prompts at effort `low`
can spend most of 1024 before the answer, so the default is the top of the
existing range. Propose defaults to 2048 so a prompt at the character cap can
be returned. Override either bound with
`LOOPITER_BENCH_PREDICT_MAX_OUTPUT_TOKENS` or
`LOOPITER_BENCH_PROPOSE_MAX_OUTPUT_TOKENS`.

A per-item content filter, a 400 whose code is clearly about that prompt
(`context_length_exceeded`, `string_above_max_length`, `invalid_prompt`), or an
incomplete response with no usable text scores 0 for that row and the run
continues. The report lists each one by row id, arm, split, and reason code,
and the summary counts them per arm and split. The log line is only the HTTP
status, error code, error type, content-filter category and severity, or
`incomplete_details.reason`, after the shared error sanitizer. Prompt text,
response text, headers, and keys are not logged. The run still stops on 401,
403, 404, 429 after the retry policy, repeated 5xx, and a 400 that is not
clearly per item (invalid parameter, unknown model or deployment). It also
stops after 5 failed predictions in a row, or when failures in one arm and
split exceed 20% of that split. Those failed calls still count against the
spend cap and the ledger.

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
