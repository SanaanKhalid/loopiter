# Publishing the Python alpha

The Python package is `loopiter`; its PEP 440 version is `0.3.0a1`. It is distinct
from the npm `0.3.0-alpha.1` artifact. Never publish from a dirty developer checkout
or assume that owning an npm name gives access to the corresponding PyPI name.

## One-time trust

PyPI's trusted publisher is scoped to `SanaanKhalid/loopiter`, workflow
`python-publish.yml`, and GitHub environment `pypi`. The GitHub environment must
restrict deployments to the `main` branch and require the repository owner's review.
Keep admin bypass disabled. GitHub and PyPI account 2FA/recovery belong to the owner;
never commit credentials, TOTP seeds, recovery codes or API tokens.

For a new project, use a pending trusted publisher in PyPI's account Publishing
settings. It does not reserve the project name. The first successful upload creates
the project, and subsequent releases use the same scoped publisher.

## Each release

1. Review the Python version, changelog, README, Fern page, capabilities and tests.
   Update the version consistently; never reuse a version for changed artifacts.
2. Commit and push the reviewed source to `main`. Record its full commit SHA.
3. Manually dispatch **Publish Python alpha** (`python-publish.yml`) on `main`,
   providing the exact version and `expected_sha`. A moved branch or version
   mismatch fails closed. A push alone never publishes a package.
4. The workflow runs the full alpha validation (Python 3.11–3.14 × PostgreSQL 16/17,
   Node 22/24 × PostgreSQL 16/17, website and Fern). Its separate build job builds
   wheel/sdist, checks metadata and installs **those exact artifacts** into clean
   consumers. Core imports, migrations, conformance and interrupted recovery run
   without the optional database driver. Inspect the logs and distribution hashes.
5. Approve the pending `pypi` environment deployment only after the intended commit
   and successful gates are confirmed. The publishing job checks out no source,
   executes no project build code, and receives `id-token: write` only there.
   PyPA's pinned publish action uploads the tested artifacts with attestations.
6. Verify the PyPI version, repository links and SHA-256 hashes against the workflow
   artifacts. Install `loopiter==VERSION` from PyPI in a fresh environment and run
   conformance/offline recovery. Verify the optional extra separately.
7. Publish the updated canonical Fern documentation and retain the actual release
   run, checksums and consumer result in `docs/python-alpha-readiness.md`.

On ambiguous upload failure, inspect PyPI and the run logs before retrying. PyPI
does not allow replacing an uploaded file; do not delete a release to overwrite it.
For a defective release, assess yanking it and issue a new version after review.

No Python live-model run is claimed: the Python example is explicitly simulated.
Both SDKs include controllers and optional provider examples; the retained live demonstration
and original reviewed classification CLI are Node-only. Release automation is
maintainer infrastructure, not a runtime service or dependency of either SDK.

References: [PyPI project creation with OIDC](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
and [Trusted Publishing](https://docs.pypi.org/trusted-publishers/using-a-publisher/).
