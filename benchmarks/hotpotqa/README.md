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
question. This harness keeps that list in dataset order. The system prompt
cannot add, drop, or reorder paragraphs.

The labeled validation split is the held-out source. Train is the source for
optimization, validation, audit, and production observation. A frozen sample of
300 validation rows is the scored held-out set, drawn with seed 1402, which is
not one of the five run seeds. Those seeds only reshuffle the train pools.
Sizes match IFBench: optimization 150, validation 150, audit 300, production
150, held-out 300. The full validation file is about 7405 rows; scoring every
row on every seed would not match the other benchmark's held-out size, so the
scored set is the frozen sample. Held-out ids are disjoint from train and are
never passed to `dataset`, `propose`, or `evaluate`.

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

The controller's paired cases use exact match. The proposer sees the question,
the frozen paragraphs, and the gold answer. It does not make an extra feedback
predict pass.

## Artifact and generation

The artifact is one versioned system prompt, `hotpotqa-system-v1`. The
character cap is 8000 Unicode code points, the same cap as the IFBench prompt
and larger than the 800-character kb-qa fragment. Answers are short, so
predict `max_output_tokens` defaults to 256 and may be set from 1 to 2048.
Propose defaults to 2048. Free-form text is the `text` field of a strict JSON
schema, because the Azure Responses client used here only accepts that shape.

## Arms

1. Frozen baseline.
2. One-shot rewrite: one propose call, applied with no gates.
3. Autonomous `ImprovementController` (`autonomous`, `selfImproving: true`)
   with the real validation, audit, and observation gates.

The report records the served held-out exact match and the ungated proposal's
held-out exact match, with seed bootstrap intervals, plus mean token F1. The
offline mock also injects a harmful candidate. The validation gate must reject
it. That check keeps the product `minimumImprovement` of 0.05.

## minimumImprovement

`--minimum-improvement` defaults to 0.05 and is written on the report. It is
not lowered silently.

At 300 audit rows, alpha 0.05, and a score range of 0 to 1, the paired
Hoeffding bound needs an observed gain of about 19 percentage points before it
clears 0.05. A smaller real gain is rejected. The ungated score is still
reported.

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
