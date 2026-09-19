# Authorized Azure live demonstration — 2026-09-19

**Result: completed an unattended Node.js improvement cycle in an isolated local
PostgreSQL application, including injected lost-receipt reconciliation.** Nothing was
published or enabled in production. Python's live provider was not exercised here;
its offline/parity results remain separate.

## Three retained attempts, including the non-successes

1. [Initial authentication attempt](autonomy-live-azure-2026-09-19.json): HTTP 401 on
   the resource's general Cognitive Services endpoint using the CLI Entra token.
   No proposal or deployment. The report conservatively retains 16,000 reserved tokens;
   it does **not** claim those tokens were billed.
2. [Semantic-label test](autonomy-live-azure-2026-09-19-key.json): Azure CLI supplied
   the existing resource key in memory; the resource's advertised OpenAI endpoint worked.
   Baseline predictions matched all nine synthetic labels, leaving zero corrections.
   Loopiter correctly returned `waiting_for_evidence / insufficient_evidence` without
   proposing or deploying. One request, 500 reported tokens.
3. [Controlled stale-mapping experiment](autonomy-live-azure-2026-09-19-opaque.json):
   a separate, frozen experiment used opaque application queue names and an explicitly
   outdated baseline mapping. The candidate changed the mapping from authored corrections.
   Gates were not relaxed to make this run pass.

Changing both endpoint and authentication in step 2 does not isolate the cause of step 1.
No Azure resource, role assignment, key rotation or IAM permission was changed. The key
was retrieved with Azure CLI and held in memory, never put in arguments, files or reports.

## Actual measurements from the controlled experiment

Deployment: existing Azure `gpt-4o`; all successful responses reported model `gpt-4o`.
The CLI inventory reported underlying deployment version `2024-11-20` at test time.

| Stage | Units | Baseline exact match | Candidate exact match |
| --- | ---: | ---: | ---: |
| Verified synthetic corrections | 6 incorrect of 9 initial predictions | — | — |
| Separate validation partition | 18 | 6/18 (33.3%) | 18/18 (100%) |
| Separate audit partition | 60 | 20/60 (33.3%) | 60/60 (100%) |
| Subsequent version-attributed observation | 9 | No concurrent control | 9/9 (100%) |

All three class guardrails passed. The recorded audit's one-sided paired-bound arithmetic
was `0.350663909634707`, exceeding the configured minimum improvement `0.05`.
Template-derived synthetic cases are **not established independent customer samples**:
this number exercises the gate implementation, not calibrated production confidence.

The proposer saw only correction examples. Deterministic exact-match scoring used authored
labels on the separately frozen validation and audit partitions. The model did not judge
its own output quality. Dataset hashes, policy, comparisons and observation are retained
in the JSON report and isolated database.

## Deployment and recovery verification

The real sequence was:

`evaluating → selected → deploying → reconciliation_required → observing → completed`

The application registry committed the new prompt, then the test deliberately threw away
the returned receipt. The next `tick` inspected the durable receipt instead of repeating
the external change. The database contains one successful apply attempt, one autonomous
approval referencing the exact audit, and no outstanding callback operations.

The recorded approval actor is `loopiter/autonomous`; no per-change human approval was used.
Later inference read the newly active prompt from PostgreSQL. Observation ran against that
version with real Azure calls and wall-clock timestamps (approximately two seconds), not
the simulated clock used by the offline fixtures. The one-second observation policy and
zero synthetic-label delay are **demo-only**, not recommended production thresholds.

The prompt mapping changed from billing → `route_cedar`, access → `route_amber` to
billing → `route_amber`, access → `route_cedar`; unrelated requests stayed `route_slate`.
Classifier weights, labels, evaluator, policy and safety instructions were unchanged.

This live run tested lost-receipt recovery, **not a real customer regression or live rollback**.
Autonomous regression rollback remains covered by the separately labeled offline/injected
Node/Python reports. No production users or targets were involved.

## Usage and retained state

- Successful controlled run: **15 requests, 9,648 reported input/output tokens**.
- All attempts combined: **17 requests, 10,148 known tokens**, plus the first attempt's
  **16,000-token conservative unknown reservation**: 26,148 charged-or-reserved tokens.
- Announced maximum: 30 requests / 120,000 tokens. No automatic provider retry was used.
- Dollar cost is not inferred; Azure billing is authoritative. The accuracy-only evaluator
  records measured tokens/example as a cost proxy, not a fabricated dollar estimate.
- Successful isolated database: `loopiter_live_1f5ff5159c8c4dd9b3a9dc8be2e89a72` in the
  existing local PostgreSQL test container. Its records are retained for inspection.
  Two other `loopiter_live_*` databases named in the earlier reports retain those attempts.
  Other databases were not migrated or modified by this demonstration.

## Interpretation and release status

This demonstrates the autonomous orchestration path with **live model calls and synthetic
ground truth**, a deliberately stale baseline, a real isolated serving change, and controlled
failure recovery. It does not prove broad self-improvement, causal production impact or
readiness for an arbitrary customer adapter. The earlier correct-baseline/no-change result
is equally valid evidence of fail-closed behavior.

The isolated Node live-demonstration gate is now evidenced. Package, Fern and website
publication, plus any production enablement, still require separate release actions.
The reproduction harness is `scripts/autonomy-live-azure.mjs`; it requires explicit `--live`,
a local database connection, endpoint/deployment, a new report path and Azure CLI credentials.
It is never invoked by ordinary CI. Reusing these synthetic cases is not fresh customer audit evidence.
