#!/usr/bin/env bash
# Roll out a versioned image. Apply updates the migration job first, runs
# migrate-loopiter-<env> to success, and only then switches web and worker.
# `build` pushes one image from the loopiter-platform checkout. It passes only
# LOOPITER_COMMIT (git rev-parse HEAD) and LOOPITER_BUILT_AT (UTC timestamp).
# LOOPITER_DEPLOY_DRY_RUN=1 prints the order or the build args and does not
# call Terraform or Azure.
set -euo pipefail
umask 077
SUBSCRIPTION=d865e614-32e3-4149-860e-36ccec037536
ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
ENVIRONMENT=${1:?Usage: deploy.sh dev|prod|development|production versioned-image [plan|apply|build]}
IMAGE=${2:?Supply the versioned ACR image}
ACTION=${3:-plan}
# Normalize before any build or rollout. Resource names stay dev or prod.
case "$ENVIRONMENT" in
  dev|development) ENVIRONMENT=dev ;;
  prod|production) ENVIRONMENT=prod ;;
  *) echo 'Choose dev, prod, development, or production' >&2; exit 2 ;;
esac
case "$ACTION" in
  plan|apply|build) ;;
  *) echo 'Choose plan, apply, or build' >&2; exit 2 ;;
esac
DRY=${LOOPITER_DEPLOY_DRY_RUN:-}
RG="rg-loopiter-$ENVIRONMENT"
JOB="migrate-loopiter-$ENVIRONMENT"
JOB_PLAN="$ROOT/${ENVIRONMENT}.migration.tfplan"
FULL_PLAN="$ROOT/${ENVIRONMENT}.tfplan"

run_cmd() {
  if [[ "$DRY" == "1" ]]; then
    printf 'RUN'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

note() {
  printf 'NOTE %s\n' "$*"
}

wait_for_job_image() {
  if [[ "$DRY" == "1" ]]; then
    echo "WAIT ${JOB} image ${IMAGE} before web and worker"
    return 0
  fi
  local deadline=$((SECONDS + 600))
  local current=""
  while (( SECONDS < deadline )); do
    if ! current=$(az containerapp job show --subscription "$SUBSCRIPTION" \
        --resource-group "$RG" --name "$JOB" --only-show-errors \
        --query "properties.template.containers[0].image" --output tsv); then
      echo "Could not read migration job ${JOB}. Web and worker were not updated." >&2
      exit 1
    fi
    current=${current//$'\r'/}
    if [[ "$current" == "$IMAGE" ]]; then return 0; fi
    sleep 5
  done
  echo "Migration job ${JOB} is still ${current:-missing}, not ${IMAGE}. Web and worker were not updated." >&2
  exit 1
}

start_migration_and_wait() {
  if [[ "$DRY" == "1" ]]; then
    run_cmd az containerapp job start --subscription "$SUBSCRIPTION" --resource-group "$RG" --name "$JOB"
    echo "WAIT ${JOB} Succeeded before web and worker"
    return 0
  fi
  local execution=""
  local active=""
  if ! active=$(az containerapp job execution list --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$JOB" --only-show-errors \
      --query "[?properties.status=='Running' || properties.status=='Processing'].name" \
      --output tsv); then
    echo "Could not list executions for ${JOB}. Web and worker were not updated." >&2
    exit 1
  fi
  if [[ -n "$active" ]]; then
    echo "Migration job ${JOB} already has an active execution (${active//$'\n'/ }). Web and worker were not updated." >&2
    exit 1
  fi
  if ! execution=$(az containerapp job start --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$JOB" --only-show-errors \
      --query name --output tsv); then
    echo "Migration job ${JOB} did not start. Web and worker were not updated." >&2
    exit 1
  fi
  execution=${execution//$'\r'/}
  if [[ -z "$execution" ]]; then
    echo "Migration job ${JOB} did not return an execution name. Web and worker were not updated." >&2
    exit 1
  fi
  local deadline=$((SECONDS + 1800))
  local status=""
  while (( SECONDS < deadline )); do
    if ! status=$(az containerapp job execution show --subscription "$SUBSCRIPTION" \
        --resource-group "$RG" --name "$JOB" --job-execution-name "$execution" \
        --only-show-errors --query properties.status --output tsv); then
      echo "Could not read migration execution ${execution}. Web and worker were not updated." >&2
      exit 1
    fi
    status=${status//$'\r'/}
    case "$status" in
      Succeeded) return 0 ;;
      Failed|Degraded|Stopped|Canceled|Cancelled)
        echo "Migration job ${JOB} execution ${execution} is ${status}. Web and worker were not updated." >&2
        exit 1 ;;
    esac
    sleep 10
  done
  echo "Migration job ${JOB} execution ${execution} timed out after 1800s (last status ${status:-unknown}). Web and worker were not updated." >&2
  exit 1
}

wait_for_app_revisions() {
  local app
  for app in "web-loopiter-$ENVIRONMENT" "worker-loopiter-$ENVIRONMENT"; do
    if [[ "$DRY" == "1" ]]; then
      echo "WAIT ${app} ready"
      continue
    fi
    local ready=false
    local _
    for _ in $(seq 1 120); do
      local state latest serving
      state=$(az containerapp show --subscription "$SUBSCRIPTION" \
        --resource-group "$RG" --name "$app" \
        --query '[properties.latestRevisionName,properties.latestReadyRevisionName]' --output tsv)
      latest=$(head -n 1 <<< "$state")
      serving=$(tail -n 1 <<< "$state")
      if [[ -n "$latest" && "$latest" == "$serving" ]]; then ready=true; break; fi
      sleep 5
    done
    if [[ "$ready" != true ]]; then
      echo "$app has not activated its new revision. Inspect revision logs; do not declare the rollout complete." >&2
      exit 1
    fi
  done
}

plan_full() {
  run_cmd terraform -chdir="$ROOT/environment" plan -input=false \
    -var-file="$ROOT/environments/${ENVIRONMENT}.tfvars" -out="$FULL_PLAN"
}

# The job does not depend on the web or worker apps, so this apply cannot switch their revisions.
plan_migration_job() {
  run_cmd terraform -chdir="$ROOT/environment" plan -input=false \
    -var-file="$ROOT/environments/${ENVIRONMENT}.tfvars" \
    -target=azurerm_container_app_job.migration -out="$JOB_PLAN"
}

apply_migration_then_rollout() {
  plan_migration_job
  run_cmd terraform -chdir="$ROOT/environment" apply -input=false "$JOB_PLAN"
  wait_for_job_image
  start_migration_and_wait
  plan_full
  run_cmd terraform -chdir="$ROOT/environment" apply -input=false "$FULL_PLAN"
  # ARM provisioning can succeed while Azure still serves an older healthy revision.
  wait_for_app_revisions
}

# Build args are only the two values computed here. Exported LOOPITER_COMMIT,
# LOOPITER_BUILT_AT, DEPLOYMENT_ENV, and every other environment variable are
# not forwarded. Validation runs before az acr build.
build_platform_image() {
  local platform commit built_at tag
  local utc_re='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$'
  if [[ -n "${LOOPITER_PLATFORM_DIR:-}" ]]; then
    platform=$LOOPITER_PLATFORM_DIR
  else
    platform=$REPO_ROOT/../loopiter-platform
  fi
  if [[ ! -d "$platform" ]]; then
    echo "loopiter-platform checkout not found at ${platform}. Image was not built." >&2
    exit 1
  fi
  platform=$(cd "$platform" && pwd)
  case "$platform" in
    "$REPO_ROOT"|"$REPO_ROOT"/*)
      echo "LOOPITER_COMMIT must come from the loopiter-platform checkout, not ${REPO_ROOT}. Image was not built." >&2
      exit 1 ;;
  esac
  unset LOOPITER_COMMIT LOOPITER_BUILT_AT
  if ! commit=$(git -C "$platform" rev-parse HEAD); then
    echo "git rev-parse HEAD failed in ${platform}. Image was not built." >&2
    exit 1
  fi
  commit=${commit//$'\r'/}
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "LOOPITER_COMMIT must match ^[0-9a-f]{40}\$ from git rev-parse HEAD in the loopiter-platform checkout. Image was not built." >&2
    exit 1
  fi
  if ! built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ); then
    echo "Could not format a UTC timestamp. Image was not built." >&2
    exit 1
  fi
  built_at=${built_at//$'\r'/}
  if [[ ! "$built_at" =~ $utc_re ]]; then
    echo "LOOPITER_BUILT_AT must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ. Image was not built." >&2
    exit 1
  fi
  if [[ "$IMAGE" != loopiterregistry7536.azurecr.io/loopiter:* ]]; then
    echo "Supply loopiterregistry7536.azurecr.io/loopiter:TAG. Image was not built." >&2
    exit 1
  fi
  tag=${IMAGE#loopiterregistry7536.azurecr.io/loopiter:}
  if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "Image tag must be one registry tag. Image was not built." >&2
    exit 1
  fi
  if [[ ! -f "$platform/Dockerfile.azure" ]]; then
    echo "Dockerfile.azure is missing in ${platform}. Image was not built." >&2
    exit 1
  fi
  if [[ "$DRY" == "1" ]]; then
    echo "DRY-RUN ${ENVIRONMENT} ${IMAGE} build"
    echo "BUILD-ARGS commit=${commit} built_at=${built_at} checkout=${platform}"
  fi
  (
    cd "$platform" || exit 1
    run_cmd az acr build \
      --subscription "$SUBSCRIPTION" \
      --registry loopiterregistry7536 \
      --image "loopiter:${tag}" \
      --file Dockerfile.azure \
      --build-arg "LOOPITER_COMMIT=${commit}" \
      --build-arg "LOOPITER_BUILT_AT=${built_at}" \
      .
  )
  if [[ "$DRY" == "1" ]]; then
    note "build passes only LOOPITER_COMMIT and LOOPITER_BUILT_AT and does not roll web or worker"
  fi
}

if [[ "$ACTION" == build ]]; then
  build_platform_image
  exit 0
fi

: "${TF_VAR_owner_email:?Set TF_VAR_owner_email}"
: "${TF_VAR_encryption_key:?Set the existing environment encryption key, or a new key for a NEW environment only}"
: "${TF_VAR_auth_secret:?Set the environment authentication secret}"
export TF_DATA_DIR="$ROOT/.terraform/$ENVIRONMENT"
export TF_VAR_image="$IMAGE"

if [[ "$DRY" == "1" ]]; then
  echo "DRY-RUN ${ENVIRONMENT} ${IMAGE} ${ACTION}"
  if [[ "$ACTION" == "plan" ]]; then
    plan_full
    note "apply updates ${JOB}, waits for Succeeded, then rolls web-loopiter-${ENVIRONMENT} and worker-loopiter-${ENVIRONMENT}"
  else
    apply_migration_then_rollout
  fi
  exit 0
fi

terraform -chdir="$ROOT/environment" init -input=false -backend-config="$ROOT/environments/${ENVIRONMENT}.backend.hcl"
terraform -chdir="$ROOT/environment" validate
if [[ "$ACTION" == "plan" ]]; then
  plan_full
  note "apply updates ${JOB}, waits for Succeeded, then rolls web-loopiter-${ENVIRONMENT} and worker-loopiter-${ENVIRONMENT}"
  exit 0
fi
apply_migration_then_rollout
