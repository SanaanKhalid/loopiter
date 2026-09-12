# Python alpha implementation / validation

Validated locally on 2026-09-12. This report records checks, not a claim of complete
Node/Python feature parity. Node package version remains
`0.2.0-alpha.1`; Python uses the PEP 440 prerelease version `0.2.0a1`.

## Implemented

- Native async Python API, dependency-free core, explicit namespace scope and JSON validation.
- Insert-idempotent executions/signals/candidates, revision-checked execution updates,
  sanitization and payload limits, structured episode-weighted analysis with evidence versions.
- Candidate evaluation, explicit approval/rejection, version-bound receipts and active pointers.
- Durable-before-call attempts, deployment reservations, inspect-only reconciliation,
  rollback lineage, callback deadlines and cooperative task cancellation.
- Python v1 adapter protocol, exported conformance suite, in-memory development store,
  optional psycopg PostgreSQL adapter and explicit packaged SQL migration.
- Simulated offline routing example: corrections → proposal → frozen holdout evaluation →
  explicit fixture approval → changed subsequent inference → rollback/recovery.
- Python README and Fern quickstart, language capability matrix, packaging and CI jobs.

## Actual checks completed

| Check | Result |
| --- | --- |
| Python 3.11.15 × PostgreSQL 16 and 17 | 38 tests passed on each database version |
| Python 3.12.13 × PostgreSQL 16 and 17 | 38 tests passed on each database version |
| Python 3.13.9 × PostgreSQL 16 and 17 | 38 tests passed on each database version |
| Python 3.14.6 × PostgreSQL 16 and 17 | 38 tests passed on each database version |
| Independent PostgreSQL clients/processes | ID/revision races, deployment conflict and receipt recovery passed |
| Failure injection | Pre-change/lost-response failures, memory/SQL finalization rollback, late callback fencing passed |
| Example | Accepted, rejected and interrupted/reconciled/rolled-back fixture paths passed |
| Python docs | Four Python blocks syntax checked; complete capture and DB setup/runtime examples executed |
| Distribution | Wheel and sdist built, Twine metadata checks passed, both installed into clean Python 3.13 consumers |
| Zero-dependency import | Core and packaged migration/conformance available with no psycopg installed |
| Python lint/format | Ruff checks passed |
| Existing Node SDK | All 49 tests passed on Node 22 with PostgreSQL 17 enabled |
| Existing TypeScript examples | 7 documentation/landing-page examples compiled |
| Fern | Local validation passed with Python page/navigation/capability changes |

The local Python matrix ran on macOS ARM64 with PostgreSQL in containers. The
GitHub Actions Linux matrix also passed for all eight Python/database combinations
in [the first release-validation run](https://github.com/SanaanKhalid/loopiter/actions/runs/34723903355).
All four Node/database combinations, Fern and artifact build/install checks passed.
The upload was correctly skipped because the website dependency audit failed.
No Windows-specific test result is claimed.

The latest clean-consumer wheel was about 27 KB compressed. This is artifact size,
not a runtime memory or throughput claim. The optional adapter was tested with
psycopg 3.3.5 / psycopg-pool 3.3.1. Packaging uses metadata 2.4 explicitly for
compatibility with the tested Twine 6.2.0 release.

## Scope boundaries

- Python does not include the Node orchestration controller, experimental auto-apply,
  JsonFileStore/legacy-import CLI or OpenAI/Azure live-model starter. The example is
  explicitly simulated; no Python live-model success is claimed.
- Python and Node use separate records, hashes, migration tables and deployment locks.
  Do not independently control the same external deployment target from both SDKs.
- The application's adapter remains responsible for durable external idempotency,
  version comparison, fencing, real rollback, credentials and authorization.

## Release preparation (2026-09-12)

- User explicitly authorized publishing Python `0.2.0a1`; no new npm publication.
- PyPI account 2FA was enabled by the owner. The pending trusted publisher is
  `SanaanKhalid/loopiter` / `python-publish.yml` / environment `pypi`.
- GitHub's `pypi` environment permits the `main` branch, requires owner review,
  and disallows admin bypass. No persistent PyPI API token is used.
- The manual workflow verifies the exact commit/version, runs all alpha CI gates,
  and uploads the exact wheel/sdist previously installed in clean consumers.
- Publication and final remote CI completion are verified below, not inferred from fixtures.
- Initial release validation exposed GHSA-rgj7-g3m4-5g8c in the website's Cloudflare
  build-tool dependency chain. Updated `@cloudflare/vite-plugin` to `1.54.8` and
  `wrangler` to `4.131.1`, and matching Workers types to `5.20260911.1`. Local website
  typecheck, lint, build and audit now pass with zero reported vulnerabilities;
  repeat the complete remote gate before uploading. Website source design and
  Python runtime dependencies are unchanged.
- The [maintainer procedure](python-release.md) documents release and failure recovery.

## Publication verified (2026-09-12)

- Published [Loopiter 0.2.0a1 on PyPI](https://pypi.org/project/loopiter/0.2.0a1/)
  under maintainer `sanaanyl` at 22:57 UTC.
- Exact release commit: `891542a82cb1b4333384b25f81c8e88381fe047a`.
- [Publishing run 34724026169](https://github.com/SanaanKhalid/loopiter/actions/runs/34724026169)
  completed successfully: all 17 jobs passed, including 8 Python/database jobs,
  4 Node/database jobs, website, Fern, exact-commit gate, artifact build and upload.
  [The separate main validation run](https://github.com/SanaanKhalid/loopiter/actions/runs/34724015645)
  also passed.
- The final release's CI wheel and sdist were downloaded and installed independently
  into clean macOS consumers before approving upload. Core conformance, packaged
  migration availability and interrupted/reconciled/rolled-back fixtures passed.
- After upload, a new Python 3.13 virtual environment installed
  `loopiter==0.2.0a1` directly from `https://pypi.org/simple` with caches disabled.
  Version, dependency-free core import and conformance passed without psycopg.
  Both rejected-candidate and interrupted/recovery fixture paths passed.
- Installing `loopiter[postgres]==0.2.0a1` from PyPI then passed **all 38 tests**
  against PostgreSQL 17 using the installed package, not an editable source checkout.
- Published file hashes match the exact tested CI artifacts. Neither file is yanked.

| Published file | Bytes | SHA-256 |
| --- | ---: | --- |
| `loopiter-0.2.0a1-py3-none-any.whl` | 27094 | `1ab0cbbe1ec4cc280137cd702a5bd6cecc5d96419cc237b7e763f34daf24cea9` |
| `loopiter-0.2.0a1.tar.gz` | 32779 | `db088fdef144a1f90b6a0fe1e54cdc2acbdad82080ce1b2a0f80fe661e58cd81` |

- PyPI's integrity API reports publish attestations from the expected GitHub
  repository, `python-publish.yml` and `pypi` environment. The owner-authorized
  environment approval was recorded after all release gates passed.
- The canonical [Python quickstart](https://loopiter.docs.buildwithfern.com/get-started/python-quickstart)
  was published with Fern 5.113.1 and verified in the browser, including PyPI install
  instructions and the Node/Python feature boundaries.
- Website/root npm audit gates passed. A local pip-audit of the Python development
  and optional PostgreSQL dependencies found no known vulnerabilities; the then-
  editable Loopiter source itself was excluded from that registry advisory lookup.
- Non-blocking CI notices: the pinned upload-artifact v4 action's Node 20 declaration
  runs under GitHub's Node 24 compatibility handling; Fern reports an unauthenticated
  deployed-redirect comparison notice in CI, which is explicitly documented in the
  check script. Authenticated local Fern validation/publication passed separately.
- No new npm package or Cloudflare website deployment occurred in this release.
  Python's example remains simulated; no Python live-model success is claimed.
