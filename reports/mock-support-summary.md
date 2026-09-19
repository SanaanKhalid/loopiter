# Mock support integration — release-candidate evidence

Executed locally on 2026-09-19 against PostgreSQL 17, using Node.js 22.23.2 and 24.21.0.
Both runs passed all four scenarios. This is an **offline simulation**, not a customer pilot.

| Scenario | Result | Captured executions | Unique signals | Durable external receipts |
| --- | --- | ---: | ---: | ---: |
| Retain valid improvement | completed | 104 | 104 | 1 apply |
| Regress after deployment | rolled_back | 104 | 104 | 1 apply + 1 rollback |
| No eligible improvement | no_improvement | 91 | 92 | 0 |
| Missing production feedback | rolled_back | 104 | 92 | 1 apply + 1 rollback |

Each scenario ingested 90 partitioned tickets (9 optimization, 21 validation, 60 audit),
plus one deliberately contradictory episode. Non-rejected scenarios then served 12 production
tickets and one final request verifying the actual retained/restored routing behavior.
Duplicate correction deliveries did not inflate signal counts. The contradictory episode
contributed two signals but no eligible dataset row.

The accepted mapping achieved a measured 2/3 improvement over the deliberately stale mapping
on 60 synthetic audit cases, with all three per-class accuracies equal to 1. These repeated
templates are not independent real customers: do not market the statistical bound or accuracy
as calibrated production performance. Production regression is deliberately injected label drift.

Assertions also covered unauthorized requests, conflicting ticket replays, disabled autonomy,
empty evidence, delayed outcomes, simultaneous worker processes, fresh-process resumptions,
lost apply responses, inspection-only recovery, and no repeated callbacks for unchanged evidence.
All loop state and serving artifacts were stored in PostgreSQL; no controller core changes were
needed for the lab to pass.

The first harness run deliberately advanced the clock by a full day while checking missing
feedback, reaching the configured timeout; the controller correctly began rollback. The harness
was corrected to check waiting at two hours and now checks timeout separately. A report-export
bug queried a nonexistent standalone evaluations collection; this was corrected to retain
candidate-embedded evaluations. Neither was an SDK failure.

## Retained results and reproduction

- [Node 24 / PostgreSQL 17](mock-support-node24-pg17.json)
- [Node 22 / PostgreSQL 17](mock-support-node22-pg17.json)
- [Run the HTTP/PostgreSQL lab](../examples/autonomous/MOCK-SUPPORT.md)
- [Separate live Azure evidence and limitations](autonomy-live-azure-summary.md)

Additionally reran the existing 104-test Node suite with PostgreSQL on Node 22 and the actual
npm tarball clean-consumer installation test; both passed. The new lab is included in CI's
Node 22/24 × PostgreSQL 16/17 matrix, but that remote CI run has not happened yet. Prior matrix
and Python evidence are recorded separately in [autonomy-validation.md](autonomy-validation.md).

Temporary HTTP servers and worker processes exited. Only this lab's random namespaces and
registry scopes were removed; unrelated database data and earlier live evidence were retained.

## Publication recommendation

Proceed toward **0.3 opt-in alpha**, not a stable/production-proven release. Before publication:

1. Review and commit the complete local change set; run required CI on that exact revision,
   including Python packages, runtime/database matrix, docs and this integration lab.
2. Confirm the release notes explain the breaking migration, default-off autonomy, adapter
   obligations, and the distinction between offline simulation and live Azure evidence.
3. Obtain explicit release authorization; publish packages and canonical documentation together.

Then invite a small number of design partners to use isolated targets with application-owned
budgets, monitoring, trusted labels and rollback. Real customer observations and operational
feedback should inform widening support; successful automation alone is not proof of improvement.
The lab is not a security audit, load test, Python HTTP integration, or production canary test.
Nothing was published, pushed, deployed publicly, or enabled in a customer application here.
