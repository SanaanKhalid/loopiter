#!/usr/bin/env bash
# Roll out a versioned image. Apply updates the migration job first, runs
# migrate-loopiter-<env> to success, and only then switches web and worker.
# LOOPITER_DEPLOY_DRY_RUN=1 prints that order and does not call Terraform or Azure.
set -euo pipefail
umask 077
SUBSCRIPTION=d865e614-32e3-4149-860e-36ccec037536
ROOT=$(cd "$(dirname "$0")" && pwd)
ENVIRONMENT=${1:?Usage: deploy.sh dev|prod versioned-image [plan|apply]}
IMAGE=${2:?Supply the versioned ACR image}
ACTION=${3:-plan}
case "$ENVIRONMENT" in dev|prod) ;; *) echo 'Choose dev or prod' >&2; exit 2;; esac
case "$ACTION" in plan|apply) ;; *) echo 'Choose plan or apply' >&2; exit 2;; esac
: "${TF_VAR_owner_email:?Set TF_VAR_owner_email}"
: "${TF_VAR_encryption_key:?Set the existing environment encryption key, or a new key for a NEW environment only}"
: "${TF_VAR_auth_secret:?Set the environment authentication secret}"
export TF_DATA_DIR="$ROOT/.terraform/$ENVIRONMENT"
export TF_VAR_image="$IMAGE"
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
    current=$(az containerapp job show --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$JOB" \
      --query "properties.template.containers[0].image" --output tsv)
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
  execution=$(az containerapp job start --subscription "$SUBSCRIPTION" \
    --resource-group "$RG" --name "$JOB" --query name --output tsv)
  if [[ -z "$execution" ]]; then
    echo "Migration job ${JOB} did not return an execution name. Web and worker were not updated." >&2
    exit 1
  fi
  local deadline=$((SECONDS + 1800))
  local status=""
  while (( SECONDS < deadline )); do
    status=$(az containerapp job execution show --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$JOB" --job-execution-name "$execution" \
      --query properties.status --output tsv)
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
