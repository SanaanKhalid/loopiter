# Pre-registered analysis plan

This plan is fixed before a HotpotQA or IFBench run. The report generator in
the public harness loads these rules from `benchmarks/public/analysis.ts` and
applies them to the saved per-question outcomes. It does not choose a test, a
margin, or a headline from the results. The controller's keep or reject gate
is unchanged and is not this headline.

Results of a run are internal.

## Primary metrics

- HotpotQA: normalized exact match, the same score the harness already uses as primary.
- IFBench: strict prompt-level accuracy.

Each item is correct or incorrect on that metric. A provider failure on the
item is incorrect and is also flagged.

## Arms

The same held-out items and the same seeds are scored for each arm.

1. Frozen baseline. The checked-in system prompt.
2. Strong prompt. A hand-written task prompt, not a model rewrite.
3. One-shot rewrite. One propose call, served with no gates.
4. Controller served. The prompt the acceptance log keeps.

The ungated controller proposal is stored on the seed. It is not a headline arm.

## Comparisons

Pairs are (seed, item) rows. The same item on two seeds is two pairs, because
each seed draws its own answers. Items are matched by id inside a seed. A seed
that did not score both sides of a pair drops that pair. Pairs are ordered by
seed, then by UTF-8 id, before resampling.

The difference is treatment minus reference. Positive means the treatment is
higher.

- Primary: controller served versus frozen baseline (`controller-served-vs-baseline`).
- Also reported, with the same rule: strong prompt versus frozen baseline, one-shot versus frozen baseline, and controller served versus strong prompt.

## Tests

Alpha is 0.05.

Paired bootstrap CI. Resample the pooled pairs with replacement. The interval
is a percentile interval of the mean difference, with linear interpolation
between order statistics (index = p × (samples − 1)). Confidence is 0.95.
Draws are 2000. The resample seed is 17. The unit is the question pair, not
the seed.

Exact McNemar. On the same pairs, count treatment-only corrects and
reference-only corrects. The discordant total is a binomial draw with
probability 0.5. The p-value is the two-sided exact binomial test: the sum of
the probabilities of outcomes at least as unlikely as the one observed. This
is not the continuity-corrected chi-square.

## Headline rule

Apply the first matching row. The report prints that row's statement.

1. Improvement. The paired bootstrap CI lower bound is strictly above 0, the point estimate is positive, and the exact McNemar p-value is below alpha.
2. Regression. The paired bootstrap CI upper bound is strictly below 0, the point estimate is negative, and the exact McNemar p-value is below alpha.
3. Safe, never regresses. The paired bootstrap CI lower bound is greater than or equal to −0.01. The non-inferiority margin is 0.01. The statement is: the lower bound is at or above the non-inferiority margin of −0.01.
4. No difference. Anything else, including a CI whose lower bound is below the non-inferiority margin, and a comparison with no pooled pairs.

Improvement is stated only when both tests agree. A lower bound above 0 with a McNemar p-value at or above alpha is safe, never regresses, because that lower bound is also above the margin.

## Prompt sensitivity

The prompt-sensitivity score is the range, maximum minus minimum, of pooled held-out primary accuracy across the frozen baseline, the strong prompt, the one-shot rewrite, and the served controller prompt. Each seed and item counts once. A provider failure counts as incorrect. The per-seed spread is the largest within-seed range of those arms and is not the score.

## Failures

Each arm reports five counts: network, timeout, http5xx, refusal, and parse.
Network is a transient socket failure. Timeout is a request timeout. http5xx
is HTTP 500, 502, 503, or 504. Refusal is a model refusal or a listed policy
refusal, including a refused propose call. Parse is an empty output or an
output that is not valid for the schema. Other item failures stay on the
item-failure list and are not added to these five counts.

## What the report stores

Per seed and per arm, each held-out question stores its id, whether it was
correct, and whether the call failed. The headline block is the primary
comparison above. The per-seed bootstrap on each arm stays in the report as a
secondary interval. Its unit is the seed.
