# 0.3 implementation and release checklist

This checklist is intentionally conservative. Unchecked work is not a supported claim.
No packages, docs or website are published by implementing this checklist.

- [x] Baseline references, exact target schemas, single-winner selection in both SDKs.
- [x] Durable controller phases, callback records, request/token reservations.
- [x] Dataset partitions, trusted-source filtering, contradiction quarantine, audit gates.
- [x] Immediate observation and rollback paths with shared simulated scenarios.
- [x] Regression coverage for concurrency, cancellation, changing policies and canary recovery.
- [x] Explicit migrations, adapter conformance and independent-process PostgreSQL verification.
- [x] Three runnable simulated workflows, mocked provider integrations and optional fixed scikit-learn workflow.
- [x] Migration/operational guides, Fern language-tab source updates and compile-checked examples.
- [x] Versioned package installation checks and supported runtime/database matrix.
- [x] Retained Node live-model report for isolated proposal, evaluation, deployment, observation and injected receipt recovery (synthetic ground truth, not production evidence).
- [x] Mock HTTP support application with real PostgreSQL and independent workers: retain, regression rollback, rejection, and missing-feedback timeout; see [report](../reports/mock-support-summary.md).
- [x] Release revision `4c4533f72815ff3c241657a4ef5349b3d364439f` committed; all exact-revision CI and publication gates passed.
- [x] User authorization for package/docs/site publication received 2026-09-19.
- [x] npm/PyPI published, registry installs verified, Fern and Cloudflare updated. See [publication record](../reports/release-0.3.md).
- [ ] Production enablement: application-owned, not authorized or implied by publication.

Test fixtures are simulated. A baseline-only live request or a rejected proposal does not
demonstrate a successful autonomous improvement cycle.

See [the local validation report](../reports/autonomy-validation.md) for exact versions,
test counts, optional skips and retained synthetic evidence. The subsequent authorized
[Azure live report](../reports/autonomy-live-azure-summary.md) records the separate live verification
results and limitations. Passing the local suite is not evidence of live model improvement, a
security audit, or a claim that arbitrary customer adapters are safe.
