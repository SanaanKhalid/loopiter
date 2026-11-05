#!/usr/bin/env bash
# Checks that apply migrates before web and worker revisions, without calling Azure.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
bash -n "$ROOT/deploy.sh"
if command -v shellcheck >/dev/null; then
  shellcheck "$ROOT/deploy.sh" "$ROOT/deploy-order.test.sh"
fi
export TF_VAR_owner_email=owner@example.test
export TF_VAR_encryption_key=test-key
export TF_VAR_auth_secret=test-secret
apply_out=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" dev example.azurecr.io/loopiter:tag apply)
plan_out=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" prod example.azurecr.io/loopiter:tag plan)
python3 - "$apply_out" "$plan_out" <<'PY'
import sys
apply_out, plan_out = sys.argv[1:]
def positions(text, needles):
    cursor = 0
    found = []
    for needle in needles:
        index = text.find(needle, cursor)
        if index < 0:
            raise SystemExit(f"missing {needle!r} after position {cursor}\n{text}")
        found.append(index)
        cursor = index + len(needle)
    return found
positions(apply_out, [
    "-target=azurerm_container_app_job.migration",
    "apply",
    "WAIT migrate-loopiter-dev image example.azurecr.io/loopiter:tag before web and worker",
    "az containerapp job start",
    "migrate-loopiter-dev",
    "WAIT migrate-loopiter-dev Succeeded before web and worker",
    "WAIT web-loopiter-dev ready",
    "WAIT worker-loopiter-dev ready",
])
full_apply = [line for line in apply_out.splitlines() if line.startswith("RUN ") and " apply " in line and "migration.tfplan" not in line]
if len(full_apply) != 1 or "-target=" in full_apply[0]:
    raise SystemExit(f"full apply must not target the job:\n{full_apply}")
if "containerapp job start" in plan_out:
    raise SystemExit("plan must not start the migration job")
if "web-loopiter-prod" not in plan_out or "worker-loopiter-prod" not in plan_out:
    raise SystemExit(plan_out)
if "acr build" in apply_out or "--build-arg" in apply_out:
    raise SystemExit("apply must not build the image\n" + apply_out)
if "acr build" in plan_out or "--build-arg" in plan_out:
    raise SystemExit("plan must not build the image\n" + plan_out)
print("deploy order ok")
PY

dev_long=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" development example.azurecr.io/loopiter:tag apply)
case "$dev_long" in
  *migrate-loopiter-dev*) ;;
  *) echo "development must select the dev stack" >&2; printf '%s\n' "$dev_long" >&2; exit 1 ;;
esac
case "$dev_long" in
  *migrate-loopiter-development*) echo "development must not rename resources" >&2; exit 1 ;;
esac
case "$dev_long" in
  *"acr build"*) echo "apply must not build" >&2; exit 1 ;;
esac
prod_long=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" production example.azurecr.io/loopiter:tag plan)
case "$prod_long" in
  *web-loopiter-prod*) ;;
  *) echo "production must select the prod stack" >&2; printf '%s\n' "$prod_long" >&2; exit 1 ;;
esac
case "$prod_long" in
  *"containerapp job start"*) echo "plan must not start the job" >&2; exit 1 ;;
esac

# Dry-run only. These invocations must not call az, terraform, or a real build.
refuse() {
  local label=$1
  shift
  local out err code=0
  err=$(mktemp)
  out=$(env "$@" 2>"$err") || code=$?
  if [[ "$code" -eq 0 ]]; then
    echo "$label: expected a non-zero exit before the build" >&2
    cat "$err" >&2
    exit 1
  fi
  if [[ "$out" == *"acr build"* || "$(cat "$err")" == *"acr build"* || "$out" == *"BUILD-ARGS"* ]]; then
    echo "$label: invalid input reached the build" >&2
    printf '%s\n' "$out" >&2
    cat "$err" >&2
    exit 1
  fi
  rm -f "$err"
}

refuse "bad environment" LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" staging \
  loopiterregistry7536.azurecr.io/loopiter:release build
refuse "empty environment" LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" "" \
  loopiterregistry7536.azurecr.io/loopiter:release build

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
platform=$work/platform
mkdir -p "$platform"
git -C "$platform" init -q
git -C "$platform" config user.email test@example.test
git -C "$platform" config user.name test
git -C "$platform" commit -q --allow-empty -m init
sha=$(git -C "$platform" rev-parse HEAD)
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "fixture commit was not a 40-character sha" >&2
  exit 1
fi

refuse "this repo is not the platform checkout" \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$ROOT/../.." \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build
refuse "missing Dockerfile" \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build

printf 'FROM scratch\n' > "$platform/Dockerfile.azure"
git -C "$platform" add Dockerfile.azure
git -C "$platform" commit -q -m dockerfile
sha=$(git -C "$platform" rev-parse HEAD)

refuse "wrong registry" \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev example.azurecr.io/loopiter:tag build

mkdir -p "$work/gitbin" "$work/datebin"
cat > "$work/gitbin/git" <<'EOF'
#!/bin/sh
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then
  printf '%s\n' "$STUB_SHA"
  exit 0
fi
echo "unexpected git: $*" >&2
exit 1
EOF
cat > "$work/datebin/date" <<'EOF'
#!/bin/sh
printf '%s\n' '2026-13-05T10:00:00Z'
exit 0
EOF
chmod 755 "$work/gitbin/git" "$work/datebin/date"

refuse "short commit" \
  PATH="$work/gitbin:$PATH" STUB_SHA=abcdefg \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build
refuse "uppercase commit" \
  PATH="$work/gitbin:$PATH" STUB_SHA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build
refuse "invalid timestamp" \
  PATH="$work/datebin:$PATH" \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build

build_out=$(
  LOOPITER_DEPLOY_DRY_RUN=1 \
  LOOPITER_PLATFORM_DIR="$platform" \
  LOOPITER_COMMIT=ffffffffffffffffffffffffffffffffffffffff \
  LOOPITER_BUILT_AT=1999-01-01T00:00:00Z \
  DEPLOYMENT_ENV=staging \
  EXTRA_BUILD_ARG=hunter2 \
  "$ROOT/deploy.sh" development loopiterregistry7536.azurecr.io/loopiter:release build
)
prod_build=$(
  LOOPITER_DEPLOY_DRY_RUN=1 \
  LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" production loopiterregistry7536.azurecr.io/loopiter:release build
)
python3 - "$build_out" "$prod_build" "$sha" <<'PY'
import re, sys
build_out, prod_build, sha = sys.argv[1:]
utc = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$")
if "DRY-RUN dev " not in build_out or "DRY-RUN development " in build_out:
    raise SystemExit("development must normalize to dev\n" + build_out)
if "DRY-RUN prod " not in prod_build:
    raise SystemExit("production must normalize to prod\n" + prod_build)
if "containerapp job start" in build_out or "terraform" in build_out:
    raise SystemExit("build must not roll out\n" + build_out)
line = next(l for l in build_out.splitlines() if "acr build" in l)
if line.count("--build-arg") != 2:
    raise SystemExit(f"expected exactly two build args:\n{line}")
if f"LOOPITER_COMMIT={sha}" not in line or f"commit={sha}" not in build_out:
    raise SystemExit(f"commit was not git rev-parse HEAD ({sha}):\n{build_out}")
stamp = re.search(r"LOOPITER_BUILT_AT=(\S+)", line)
if not stamp or not utc.fullmatch(stamp.group(1)):
    raise SystemExit(f"timestamp was not strict UTC:\n{line}")
if "ffffffffffffffffffffffffffffffffffffffff" in build_out or "1999-01-01" in build_out:
    raise SystemExit("environment values were used as build args\n" + build_out)
for banned in ("hunter2", "DEPLOYMENT_ENV", "EXTRA_BUILD_ARG", "staging", "--secret-build-arg"):
    if banned in build_out:
        raise SystemExit(f"unexpected {banned} in build output\n{build_out}")
names = re.findall(r"--build-arg (?:=)?([A-Za-z0-9_]+)=", line)
if names != ["LOOPITER_COMMIT", "LOOPITER_BUILT_AT"]:
    raise SystemExit(f"build arg names: {names}\n{line}")
print("build args ok")
PY
