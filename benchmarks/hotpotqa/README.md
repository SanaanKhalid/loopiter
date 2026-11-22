# HotpotQA distractor benchmark

Internal comparison of a frozen system prompt, a one-shot rewrite, and the
autonomous `ImprovementController`. Results are internal. Do not publish them,
attach them to a release, or commit them.

This module does not change `benchmarks/kb-qa`.

## Data and license

Hugging Face `hotpotqa/hotpot_qa`, config `distractor`, revision
`1908d6afbbead072334abe2965f91bd2709910ab`. License CC BY-SA 4.0. Attribute
the HotpotQA authors (Yang et al.).

The distractor setting supplies a fixed 10-paragraph context with each
question. Hugging Face stores `context` as a struct of parallel `title` and
`sentences` lists. This harness joins each sentence list into one paragraph
and keeps that list in dataset order. The system prompt cannot add, drop, or
reorder paragraphs.

Some official rows have 2 to 9 paragraphs. Fetch drops those rows in both the
train and validation splits, and the cache loader drops any short row that is
still present. The raw, kept, and dropped counts for each split are recorded
in `benchmarks/.cache/hotpotqa/manifest.json` under `splits`. At the pinned
revision, train drops 838 of 90,447 rows and validation drops 60 of 7,405.
The frozen 1000-row held-out sample is drawn with seed 1402 from the validation
rows that remain after that filter. It is a longer prefix of that same shuffle,
so the previous 300-row sample is the first 300 ids. Seed 1402 is not one of
the five run seeds. Those seeds only reshuffle the train pools. Sizes are
optimization 150, validation 150, audit 300, production 150, and held-out 1000.
IFBench held-out stays its official test set. Held-out ids are disjoint from
train and from the optimization, validation, audit, and production rows, and
they are never passed to `dataset`, `propose`, or `evaluate`.

The fixture eval split has a committed lock, `fixtures.eval.lock.json`, checked
before a fixture run. The 1000-row sample has a committed lock,
`pinned-eval.lock.json`. Cache load requires that file and stops before any
model call if it is missing or the loaded eval split differs. See the
benchmarks README and [analysis-plan.md](../analysis-plan.md).

Regenerate the lock from the pinned cache. The cache comes from `fetch.py`.
A correct file is byte-identical to the committed lock.

```sh
npm run build
node dist/benchmarks/hotpotqa/write-eval-lock.js
```

## Fetch

```sh
python -m pip install pyarrow
python benchmarks/hotpotqa/fetch.py
```

The cache is gitignored. `CI=true` refuses the download. Tests use the
checked-in synthetic fixtures, each with 10 short paragraphs.

## Score

Normalized exact match is the primary metric. Token F1 is reported beside it.
Both follow `hotpot_evaluate_v1.py` at commit
`3635853403a8735609ee997664e1528f4480762a` of
[hotpotqa/hotpot](https://github.com/hotpotqa/hotpot): lower case, strip
punctuation, drop the articles a/an/the, collapse whitespace, then exact match
or token overlap. The yes/no/noanswer answers score F1 only on an exact
normalized match. The port's copyright and the Apache-2.0 text are in
[benchmarks/NOTICE](../NOTICE).

The controller's paired cases use exact match. The proposer sees a bounded sample, not every optimization row and not all 10
paragraphs. Failures come first. The rest are a shuffle with seed 1402. At
most 8 examples are sent, and the JSON payload stays within 16384 bytes
(`LOOPITER_BENCH_PROPOSE_EXAMPLES` and `LOOPITER_BENCH_PROPOSE_BYTES`). Each
example keeps the question, the gold answer, a score, and the supporting-fact
paragraphs (the gold titles when the cache has them, otherwise paragraphs that
contain the answer). Held-out rows are still never passed to propose.

## Artifact and generation

The artifact is one versioned system prompt, `hotpotqa-system-v1`. The
character cap is 8000 Unicode code points, the same cap as the IFBench prompt
and larger than the 800-character kb-qa fragment. Answers are short, but a
reasoning model counts reasoning tokens against `max_output_tokens`. The
harness sends `reasoning.effort` (default `low`). The default bound is 2048,
so that effort can finish and still leave room for the short answer. It may
be set from 1 to 8192. IFBench uses a higher answer bound because those
answers are long. Propose defaults to 2048. Free-form text is the `text`
field of a strict JSON schema, because the Azure Responses client used here
only accepts that shape.

Per-item provider failures are the same as IFBench: a content filter, a
prompt-scoped 400, or an incomplete response with no usable text scores 0
for that row and the run continues. A truncation
(`incomplete:max_output_tokens`) also scores 0, and it is listed in the same
item-failure summary, but it does not count toward the content-filter
fraction or the five-in-a-row stop. When truncations in one arm and split
exceed 20% of that split, the run stops with `output_truncated`. The report
and summary record the row, arm, split, and reason. Exhausted transient
network retries and HTTP 500, 502, 503, and 504 fail that seed. Enough of those
failures in a row stop the run. The run still stops on
401, 403, 404, 429, and a systemic 400. It also stops after 5
non-truncation prediction failures in a row, or when those failures in one
arm and split exceed 20% of that split. A 4xx with no token usage,
including a 429, releases the pre-call reservation and costs $0. A timeout or
a dropped connection after the request was sent is charged the full ceiling.

## Arms

1. Frozen baseline.
2. Strong prompt: a hand-written multi-hop prompt, scored on the same held-out
   items and seeds. It is not a model rewrite.
3. One-shot rewrite: one propose call, applied with no gates.
4. Autonomous `ImprovementController` (`autonomous`, `selfImproving: true`).
   Validation and audit use the opt-in confidence rule described in the
   benchmarks README. The product default keeps the fixed margin. The served
   prompt is the accepted candidate with the highest paired audit effect.

The report stores each held-out question per arm and per seed. The headline is
the paired bootstrap and exact McNemar comparison in the analysis plan. The
seed bootstrap stays as a secondary interval. The report also counts network,
timeout, 5xx, refusal, and parse failures per arm, and it records the
prompt-sensitivity score. Mean token F1 is still reported. The offline mock
also injects a harmful candidate. The validation gate must reject it.

## Acceptance

`--minimum-improvement` defaults to 0.05 and is written on the report. Benchmark
acceptance is a paired bootstrap lower bound above `--minimum-effect` (default
0), at confidence 0.90. That is separate from the product default, which still
uses the fixed margin. Audit uses the same benchmark rule. The ungated score
is still reported. See the benchmarks README for the decision log and
`replay.js`.

## Commands

```sh
npm run build
node dist/benchmarks/hotpotqa/run.js --fixtures --seeds 1
```

```sh
LOOPITER_BENCH_PRICE_INPUT_PER_1M=1 \
LOOPITER_BENCH_PRICE_OUTPUT_PER_1M=2 \
node dist/benchmarks/hotpotqa/run.js --estimate
```

Live mode matches `benchmarks/kb-qa`: `--live` and `LOOPITER_BENCH_ALLOW_LIVE=1`,
the price and cap variables, and the cumulative ledger at
`reports/hotpotqa-live/ledger.json`. `--smoke` is 1 seed and 30 rows per split.
The key is not logged or written. No live call runs in CI.
