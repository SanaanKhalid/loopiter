# Reliable public alpha release checklist

Historical 0.2 checklist. For the current release use [the 0.3 release gates](autonomy-release-checklist.md).

Target: `loopiter@0.2.0-alpha.1`, npm tag **alpha**, MIT, Node 22/24.
This file prepares intentional release actions; no publication or visibility change
is performed by the build, tests, starter or CI.

## Validation gates

- [ ] Review this breaking API and `SUPPORTED.md`; no unsafe v0.1 wrappers.
- [ ] `npm ci`, `npm run typecheck`, `npm test` on supported Node releases.
- [ ] Supply an isolated `LOOPITER_TEST_DATABASE_URL`; run the tests on PostgreSQL 16/17.
      The PostgreSQL test must not be skipped in the release matrix.
- [ ] Pass development/PG adapter conformance, independent-process CAS, independent-pool
      target contention, prepare/apply/receipt/rollback faults and reconciliation.
- [ ] `npm run starter -- demo`, `demo --reject`, and `demo --interrupt`.
- [ ] `npm run test:package`: build-before-pack, clean tarball install, imports/types,
      CLI, packaged migration and no installed `pg` requirement for the SDK.
- [ ] `npm run test:docs` and `npm run test:fern`. Fern MDX parse warnings fail the gate.
      CI runs Fern's local validation without credentials; also run authenticated
      `npx --yes fern-api@5.113.1 check --warnings` before docs publication to check
      redirects against the deployed site.
- [ ] Website: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`.
- [ ] Root and website `npm audit --audit-level=high`; resolve high/critical findings
      or retain a specific, reviewed non-applicability justification.
- [ ] Record `npm run benchmark` output with Node/platform and the fixed dataset;
      never extrapolate it into a throughput guarantee.
- [ ] Confirm the intended GitHub Actions jobs actually pass after a separately
      authorized push. Local equivalents are not a claimed remote CI run.

The implemented workflow is `.github/workflows/alpha.yml`. It validates only; it
does not publish a package, change visibility, deploy Sites/Fern or call a live model.

## Mandatory live-model verification

Configure your own test database, namespace, OpenAI credentials and explicit model
(or Azure OpenAI endpoint, deployment and key/Entra token). Review
data-transfer and cost limits in the starter runbook. Do not send real customer data
for the initial smoke. Initialize explicitly, then run:

```sh
npm run starter -- smoke --live --report ./loopiter-live-smoke.json
```

Retain the actual report with model/prompt/dataset versions, case results, gates,
latency and token usage where supplied. A missing key/model is a blocked check, not
a fixture success. A genuine no-candidate/failing-candidate outcome is valid and must
be reported honestly. If one passes, manually review/approve, deploy, predict, roll
back and retain those actual reports too. Synthetic offline success does not prove
usefulness on production data or model reliability.

## Publisher and public-access checks — owner actions

1. Verify the intended npm account with `npm whoami` and its MFA/publishing policy.
2. Recheck `npm view loopiter name version maintainers --json`. E404 is not a reservation
   or proof of permission to claim the name. If it exists, verify your publisher rights
   before any publication. Do not invent or silently switch the package name.
3. Review the final `npm pack --dry-run`, actual tarball and MIT license contents.
4. Enable and test GitHub private vulnerability reporting. Review repository contents
   for credentials and intentionally choose whether to make the repo public.
5. Obtain explicit release approval. Only then run `npm publish --tag alpha --access public`
   from the reviewed commit/tarball. Check the resulting version, integrity and dist-tags;
   do not accidentally move `latest`. Commit/tag/push are separate authorized actions.
6. Intentionally publish Fern from the correct repository/branch, and deploy the
   **existing** Sites project; do not create a replacement. Verify its intended access
   policy and anonymous behavior. Preparation does not make today's hosted site public.
7. Check landing-page Docs/Get Started/footer links, `/docs` and `/docs/`, all known
   legacy anchors, canonical Fern pages and the source clone instructions after launch.

## Maintenance commitments for this alpha

Newest-alpha fixes only; no SLA, billing or managed operations. Document breaking
changes and data migration. Keep recommendation as the default, treat auto-apply as
experimental, and preserve application ownership of scheduling, databases and secrets.
