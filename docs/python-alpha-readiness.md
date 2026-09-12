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
- Publication and remote CI completion are pending; successful results and the
  final artifact hashes will be appended after verification, never inferred from fixtures.
- Initial release validation exposed GHSA-rgj7-g3m4-5g8c in the website's Cloudflare
  build-tool dependency chain. Updated `@cloudflare/vite-plugin` to `1.54.8` and
  `wrangler` to `4.131.1`, and matching Workers types to `5.20260911.1`. Local website
  typecheck, lint, build and audit now pass with zero reported vulnerabilities;
  repeat the complete remote gate before uploading. Website source design and
  Python runtime dependencies are unchanged.
- The [maintainer procedure](python-release.md) documents release and failure recovery.
