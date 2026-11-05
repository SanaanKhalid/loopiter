# Secret scanning

Pull requests and pushes to `main` run gitleaks. A weekly schedule and
`workflow_dispatch` also scan the full git history. `deploy.sh build` scans the
archived platform tree with the same gitleaks version. Findings are printed
with `--redact`.

`LOOPITER_SKIP_SECRET_SCAN=1` is the only way to skip the deploy-time scan. It
prints a warning. A dry-run skips that scan.

## False positives

Prefer a narrow match over a path allowlist. A path allowlist hides every
future line in that file. Use one of these instead:

- A line or rule pattern that matches only the known non-secret identifier.
- An inline gitleaks marker on the specific line.

Add a path allowlist only for a fixture that exists so a test can prove the
scan fails closed.

## A real leak

1. Rotate or revoke the credential first. Assume it is exposed as soon as it
   is pushed.
2. Remove it from the current tree and from git history.
3. Audit where the credential was used and who could have read it.
