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
IMAGE=loopiterregistry7536.azurecr.io/loopiter:tag
apply_out=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" dev "$IMAGE" apply)
plan_out=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" prod "$IMAGE" plan)
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
    "az acr repository show",
    "blob lease acquire",
    "-target=azurerm_container_app_job.migration",
    "CHECK targeted plan changes only azurerm_container_app_job.migration",
    "apply",
    "WAIT migrate-loopiter-dev image loopiterregistry7536.azurecr.io/loopiter:tag before web and worker",
    "az containerapp job start",
    "CHECK migrate-loopiter-dev execution image loopiterregistry7536.azurecr.io/loopiter:tag",
    "WAIT migrate-loopiter-dev Succeeded before web and worker",
    "CAPTURE previous images",
    "-target=azurerm_container_app.worker",
    "CHECK targeted plan changes only azurerm_container_app.worker",
    "WAIT worker-loopiter-dev ready image ",
    "-target=azurerm_container_app.web",
    "CHECK targeted plan changes only azurerm_container_app.web",
    "WAIT web-loopiter-dev ready image ",
    "both revisions serve ",
])
web_at = apply_out.find("-target=azurerm_container_app.web")
worker_ready = apply_out.find("WAIT worker-loopiter-dev ready")
if worker_ready < 0 or web_at < worker_ready:
    raise SystemExit("web must be planned only after the worker is ready\n" + apply_out)
full_apply = [
    line for line in apply_out.splitlines()
    if line.startswith("RUN ") and " apply " in line
    and "migration.tfplan" not in line and "worker.tfplan" not in line and "web.tfplan" not in line
]
if len(full_apply) != 1 or "-target=" in full_apply[0]:
    raise SystemExit(f"full apply must not target one app:\n{full_apply}")
full_at = apply_out.find(full_apply[0])
if full_at < apply_out.find("WAIT web-loopiter-dev ready"):
    raise SystemExit("full apply must follow both app waits")
if "containerapp job start" in plan_out or "blob lease acquire" in plan_out:
    raise SystemExit("plan must not lock or start the migration job")
if "az acr repository show" not in plan_out:
    raise SystemExit("plan must resolve a tag to a digest\n" + plan_out)
if "web-loopiter-prod" not in plan_out or "worker-loopiter-prod" not in plan_out:
    raise SystemExit(plan_out)
if "acr build" in apply_out or "--build-arg" in apply_out:
    raise SystemExit("apply must not build the image\n" + apply_out)
if "acr build" in plan_out or "--build-arg" in plan_out:
    raise SystemExit("plan must not build the image\n" + plan_out)
print("deploy order ok")
PY

dev_long=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" development "$IMAGE" apply)
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
prod_long=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" production "$IMAGE" plan)
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
exec /usr/bin/git "$@"
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
python3 - "$build_out" "$prod_build" "$sha" "$platform" <<'PY'
import re, sys
build_out, prod_build, sha, platform = sys.argv[1:]
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
show_at = build_out.find("repository show")
archive_at = build_out.find("ARCHIVE HEAD")
build_at = build_out.find("acr build")
if not (0 <= show_at < build_at) or archive_at < 0 or archive_at > build_at:
    raise SystemExit("build must archive HEAD and refuse an existing tag first\n" + build_out)
context = line.split()[-1]
if context in {".", platform} or context.startswith(platform + "/"):
    raise SystemExit("build context must be an archive, not the working tree\n" + line)
if "already exists" not in build_out:
    raise SystemExit(build_out)
print("build args ok")
PY

printf 'tracked\n' > "$platform/extra.txt"
refuse "dirty tracked file" \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build
rm -f "$platform/extra.txt"
mkdir -p "$platform/nested"
printf 'untracked\n' > "$platform/nested/new.txt"
refuse "dirty untracked file" \
  LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build
rm -rf "$platform/nested"

bad_apply=$(mktemp)
if LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" dev 'not-an-image' apply >"$bad_apply" 2>"$work/bad-apply.err"; then
  echo "invalid apply image must fail" >&2
  exit 1
fi
if grep -q 'blob lease acquire' "$bad_apply" || grep -q 'acr build' "$bad_apply"; then
  echo "invalid apply image reached the lock or a build" >&2
  cat "$bad_apply" >&2
  exit 1
fi
rm -f "$bad_apply"

digest=loopiterregistry7536.azurecr.io/loopiter@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
digest_out=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" dev "$digest" apply)
if [[ "$digest_out" == *"acr repository show"* ]]; then
  echo "a digest apply must not resolve a tag" >&2
  printf '%s\n' "$digest_out" >&2
  exit 1
fi
case "$digest_out" in
  *"blob lease acquire"*) ;;
  *) echo "digest apply must still lock" >&2; exit 1 ;;
esac
case "$digest_out" in
  *"CHECK migrate-loopiter-dev execution image ${digest}"*) ;;
  *) echo "digest apply must check the execution image" >&2; exit 1 ;;
esac

worker_fail=$(mktemp)
worker_err=$(mktemp)
if LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_DEPLOY_DRY_RUN_FAIL_APP=worker \
  "$ROOT/deploy.sh" dev "$IMAGE" apply >"$worker_fail" 2>"$worker_err"; then
  echo "worker wait failure must abort" >&2
  exit 1
fi
if grep -q -- '-target=azurerm_container_app.web' "$worker_fail"; then
  echo "web must not be planned when the worker wait fails" >&2
  cat "$worker_fail" >&2
  exit 1
fi
if ! grep -q 'ROLLBACK worker-loopiter-dev' "$worker_fail"; then
  echo "worker wait failure must roll the worker back" >&2
  cat "$worker_fail" >&2
  exit 1
fi
rm -f "$worker_fail" "$worker_err"

web_fail=$(mktemp)
if LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_DEPLOY_DRY_RUN_FAIL_APP=web \
  "$ROOT/deploy.sh" dev "$IMAGE" apply >"$web_fail" 2>"$work/web-fail.err"; then
  echo "web wait failure must abort" >&2
  exit 1
fi
python3 - "$web_fail" <<'PY'
import sys
text = open(sys.argv[1]).read()
worker = text.find("WAIT worker-loopiter-dev ready")
web_plan = text.find("-target=azurerm_container_app.web")
web_fail = text.find("WAIT web-loopiter-dev failed")
rollback = text.find("ROLLBACK web-loopiter-dev and worker-loopiter-dev")
if min(worker, web_plan, web_fail, rollback) < 0 or not (worker < web_plan < web_fail < rollback):
    raise SystemExit("web failure must follow a ready worker and roll both back\n" + text)
after = text.split("ROLLBACK", 1)[1]
for line in after.splitlines():
    if " apply " in line and line.rstrip().endswith("dev.tfplan"):
        raise SystemExit("full apply must not run after a web wait failure\n" + text)
PY
rm -f "$web_fail"

guard=$ROOT/migration-plan-guard.py
printf '%s' '{"resource_changes":[
  {"address":"azurerm_container_app_job.migration","change":{"actions":["update"]}},
  {"address":"azurerm_key_vault_secret.runtime","change":{"actions":["no-op"]}}
]}' | python3 "$guard" azurerm_container_app_job.migration
if printf '%s' '{"resource_changes":[
  {"address":"azurerm_container_app_job.migration","change":{"actions":["update"]}},
  {"address":"azurerm_postgresql_flexible_server.db","change":{"actions":["update"]}}
]}' | python3 "$guard" azurerm_container_app_job.migration >/dev/null 2>&1; then
  echo "a targeted plan that changes the database must fail" >&2
  exit 1
fi
if printf '%s' '{"resource_changes":[
  {"address":"azurerm_container_app.worker","change":{"actions":["update"]}},
  {"address":"azurerm_role_assignment.acr_runtime","change":{"actions":["create"]}}
]}' | python3 "$guard" azurerm_container_app.worker >/dev/null 2>&1; then
  echo "a worker plan that changes a role assignment must fail" >&2
  exit 1
fi
printf '%s' '{"resource_changes":[
  {"address":"azurerm_container_app.web","change":{"actions":["no-op"]}}
]}' | python3 "$guard" azurerm_container_app.web
echo "plan guard ok"

restore_out=$(mktemp)
restore_err=$(mktemp)
restore_code=0
LOOPITER_DEPLOY_DRY_RUN=1 \
  LOOPITER_DEPLOY_DRY_RUN_FAIL_APP=web \
  LOOPITER_DEPLOY_DRY_RUN_FAIL_RESTORE=web \
  "$ROOT/deploy.sh" dev "$IMAGE" apply >"$restore_out" 2>"$restore_err" || restore_code=$?
if [[ "$restore_code" -ne 3 ]]; then
  echo "a failed restore must exit 3, got ${restore_code}" >&2
  cat "$restore_err" >&2
  exit 1
fi
if grep -q 'returned to the previous image' "$restore_out" "$restore_err"; then
  echo "a failed restore must not claim the apps were returned" >&2
  exit 1
fi
if ! grep -q 'ERROR: failed to restore web-loopiter-dev' "$restore_err"; then
  echo "restore error must name web-loopiter-dev" >&2
  cat "$restore_err" >&2
  exit 1
fi
rm -f "$restore_out" "$restore_err"

expect_packaged() {
  local rel=$1 mode=$2
  local out err code=0
  mkdir -p "$platform/$(dirname "$rel")"
  printf 'x\n' > "$platform/$rel"
  git -C "$platform" add -- "$rel"
  git -C "$platform" commit -q -m "add $rel"
  err=$(mktemp)
  out=$(LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
    "$ROOT/deploy.sh" dev loopiterregistry7536.azurecr.io/loopiter:release build 2>"$err") || code=$?
  if [[ "$mode" == refuse ]]; then
    if [[ "$code" -eq 0 || "$out" == *"acr build"* ]] || ! grep -q 'Refusing to package environment or key files' "$err"; then
      echo "expected refuse for $rel" >&2
      printf '%s\n' "$out" >&2
      cat "$err" >&2
      exit 1
    fi
  else
    if [[ "$code" -ne 0 || "$out" != *"acr build"* || "$out" == *"Refusing to package"* ]] || grep -q 'Refusing to package' "$err"; then
      echo "expected allow for $rel" >&2
      printf '%s\n' "$out" >&2
      cat "$err" >&2
      exit 1
    fi
  fi
  rm -f "$err"
  git -C "$platform" rm -q -- "$rel"
  git -C "$platform" commit -q -m "drop $rel"
}
expect_packaged .env refuse
expect_packaged apps/web/.env.production refuse
expect_packaged Config/.ENV refuse
expect_packaged keys/app.pem refuse
expect_packaged keys/app.key refuse
expect_packaged keys/app.p12 refuse
expect_packaged keys/app.pfx refuse
expect_packaged id_rsa refuse
expect_packaged id_rsa.pub refuse
expect_packaged id_ed25519 refuse
expect_packaged id_ed25519.pub refuse
expect_packaged id_ecdsa refuse
expect_packaged id_dsa refuse
expect_packaged credentials refuse
expect_packaged credentials.ini refuse
expect_packaged Config/Credentials.INI refuse
expect_packaged credentials.example allow
expect_packaged prod.tfvars refuse
expect_packaged terraform.tfstate refuse
expect_packaged terraform.tfstate.backup refuse
expect_packaged .npmrc refuse
expect_packaged .pypirc refuse
expect_packaged kubeconfig refuse
expect_packaged credentials.json refuse
expect_packaged credentials-prod.json refuse
expect_packaged service-account.json refuse
expect_packaged service-account-dev.json refuse
expect_packaged .env.example.local refuse
expect_packaged .env.sample.bak refuse
expect_packaged .dev.vars refuse
expect_packaged .env.example allow
expect_packaged .ENV.EXAMPLE allow
expect_packaged .dev.vars.sample allow
echo "packaging guard ok"

prev=loopiterregistry7536.azurecr.io/loopiter@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
retry_image=loopiterregistry7536.azurecr.io/loopiter:redeploy
retry_first=$(mktemp)
retry_err=$(mktemp)
retry_code=0
LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_DEPLOY_DRY_RUN_FAIL_APP=web \
  "$ROOT/deploy.sh" dev "$retry_image" apply >"$retry_first" 2>"$retry_err" || retry_code=$?
if [[ "$retry_code" -ne 1 ]]; then
  echo "web wait failure with a successful restore must exit 1, got ${retry_code}" >&2
  cat "$retry_err" >&2
  exit 1
fi
if ! grep -q "image=${prev}" "$retry_first"; then
  echo "rollback plan must use the previous digest" >&2
  exit 1
fi
if ! grep -q -- '-target=azurerm_container_app.web' "$retry_first" \
  || ! grep -q -- '-target=azurerm_container_app.worker' "$retry_first"; then
  echo "rollback must target both apps through Terraform" >&2
  exit 1
fi
if ! grep -q 'returned to the previous image' "$retry_err"; then
  echo "successful restore should say the apps were returned" >&2
  cat "$retry_err" >&2
  exit 1
fi
retry_second=$(LOOPITER_DEPLOY_DRY_RUN=1 "$ROOT/deploy.sh" dev "$retry_image" apply)
if ! grep -q ' apply ' <<<"$retry_second"; then
  echo "retrying the same image must plan and apply again" >&2
  exit 1
fi
if ! grep -q 'loopiter:redeploy' <<<"$retry_second"; then
  echo "retry must roll out the requested image" >&2
  exit 1
fi
rm -f "$retry_first" "$retry_err"

lock_err=$(mktemp)
lock_code=0
LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_DEPLOY_DRY_RUN_FAIL_LOCK_RELEASE=1 \
  "$ROOT/deploy.sh" dev "$IMAGE" apply >/dev/null 2>"$lock_err" || lock_code=$?
if [[ "$lock_code" -eq 0 ]]; then
  echo "a failed lock release must be non-zero" >&2
  exit 1
fi
if ! grep -q "ERROR: failed to release deploy lock ${LOCK_BLOB:-locks/deploy-dev.lock}. The lease is still held." "$lock_err"; then
  echo "lock release failure must name the still-held lease" >&2
  cat "$lock_err" >&2
  exit 1
fi
rm -f "$lock_err"

nopy_code=0
PATH=/does-not-exist /bin/bash "$ROOT/deploy.sh" dev "$IMAGE" plan >/dev/null 2>"$work/nopy.err" || nopy_code=$?
if [[ "$nopy_code" -eq 0 ]] || ! grep -q 'python3 is required' "$work/nopy.err"; then
  echo "missing python3 must fail early" >&2
  cat "$work/nopy.err" >&2
  exit 1
fi
echo "restore and lock checks ok"
