# Loopiter 0.3 alpha publication — 2026-09-19

User explicitly authorized package, documentation and landing-page publication.
No customer production autonomy was enabled.

## Source and gates

Released source: `4c4533f72815ff3c241657a4ef5349b3d364439f` on `main`.

- [Exact-revision CI: all 15 jobs passed](https://github.com/SanaanKhalid/loopiter/actions/runs/35465932208).
- [Python release: all validation, build and protected publication jobs passed](https://github.com/SanaanKhalid/loopiter/actions/runs/35465940988).
- Matrix: Node 22/24 × PostgreSQL 16/17; Python 3.11–3.14 × PostgreSQL 16/17;
  optional fixed-model ML example, package installation, docs, website and dependency checks.
- Local final Node tarball clean-consumer test passed before publication.
- Local final Python suite: 66 tests passed, including optional scikit-learn.

## Published artifacts

| Distribution | Version | Registry verification |
| --- | --- | --- |
| [npm](https://www.npmjs.com/package/loopiter/v/0.3.0-alpha.1) | 0.3.0-alpha.1 | alpha tag; clean registry install, core/controller imports and store conformance passed |
| [PyPI](https://pypi.org/project/loopiter/0.3.0a1/) | 0.3.0a1 | wheel/sdist published through Trusted Publishing with attestations; clean isolated registry install and store conformance passed |

npm accepted the upload before registry propagation completed. Initial reads returned 404;
no duplicate upload was attempted. Subsequent version lookup and installation succeeded.
The existing `latest` tag remains `0.2.0-alpha.1`; only `alpha` was advanced.

npm tarball SHA-1 (matches the prepublication clean-consumer artifact):
`c8308a4dc8872b4466c14e20f29bba33eb3e9d9b`

npm integrity:
`sha512-f/dR4dmlteDLKnwIEpKlWaLa41v6cflW86K4nhfGAgG411bfV3fEt6elr1spnPQvLH3wL4mpzwXtZQ9TnB7YIw==`

PyPI SHA-256 values matched the successful workflow's publishing attestations:

- `loopiter-0.3.0a1-py3-none-any.whl`: `35b41b1e3089da2d677e4eaa05609132062521cc84c68a2d0799f66faa3a15e2`
- `loopiter-0.3.0a1.tar.gz`: `66fd987e1a7cac8af33cb8ebcefde507130e94a899ef61b2a83cbd4329d80e95`

## Published documentation and site

- Fern CLI 5.113.1 successfully published 26 pages with strict broken-link validation.
- [Canonical docs](https://loopiter.docs.buildwithfern.com/get-started/overview) verified
  in the browser with 0.3 versions and successful Node.js → Python → Node.js switching.
- [Release validation](https://loopiter.docs.buildwithfern.com/get-started/release-validation)
  includes the realistic mock support lab and the separately labeled live Azure evidence.
- [Landing page](https://loopiter.co/) deployed to its existing Cloudflare Worker;
  version `f505ebac-be8b-460a-835a-be26f3d1848f`. HTTP verification found the new
  autonomous-mode description and `v0.3.0-alpha.1` label. Existing design preserved.

Historical 0.2 migration/release reports are retained as historical evidence, not rewritten.
The current guides, API references, installation commands, capability matrix, security/autonomy
descriptions and landing-page copy describe 0.3. The documentation and evidence record is
updated after release without changing immutable registry artifacts.

## Scope

This is a breaking, opt-in alpha—not a production effectiveness or security certification.
See [mock integration results](mock-support-summary.md), [live Azure limitations](autonomy-live-azure-summary.md)
and [migration](../docs/autonomy-migration.md). Existing storage must be migrated explicitly.
No automatic model training, code editing, agent spawning or hosted scheduling is included.
