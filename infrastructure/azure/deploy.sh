#!/usr/bin/env bash
# Roll out a versioned image. Apply locks the environment, migrates first, and
# only then switches worker and web. Build stamps one image from a clean
# archive of the platform checkout.
# LOOPITER_DEPLOY_DRY_RUN=1 prints the order and does not call Terraform or Azure.
set -euo pipefail
umask 077
SUBSCRIPTION=d865e614-32e3-4149-860e-36ccec037536
STATE_ACCOUNT=loopitertfstate7536
STATE_CONTAINER=tfstate
REGISTRY=loopiterregistry7536
IMAGE_PREFIX="${REGISTRY}.azurecr.io/loopiter"
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
DRY_FAIL_APP=""
if [[ "$DRY" == "1" ]]; then
  DRY_FAIL_APP=${LOOPITER_DEPLOY_DRY_RUN_FAIL_APP:-}
fi
RG="rg-loopiter-$ENVIRONMENT"
JOB="migrate-loopiter-$ENVIRONMENT"
LOCK_BLOB="locks/deploy-${ENVIRONMENT}.lock"
JOB_PLAN="$ROOT/${ENVIRONMENT}.migration.tfplan"
WORKER_PLAN="$ROOT/${ENVIRONMENT}.worker.tfplan"
WEB_PLAN="$ROOT/${ENVIRONMENT}.web.tfplan"
FULL_PLAN="$ROOT/${ENVIRONMENT}.tfplan"
LOCK_LEASE=""
BUILD_CONTEXT=""
PREV_WEB_IMAGE=""
PREV_WORKER_IMAGE=""
TAG_RE='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'
UTC_RE='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$'

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

release_deploy_lock() {
  local id=${LOCK_LEASE:-}
  LOCK_LEASE=""
  if [[ -z "$id" ]]; then
    return 0
  fi
  az storage blob lease release --subscription "$SUBSCRIPTION" \
    --account-name "$STATE_ACCOUNT" --container-name "$STATE_CONTAINER" \
    --blob-name "$LOCK_BLOB" --lease-id "$id" --auth-mode login \
    || echo "Could not release deploy lock ${LOCK_BLOB}. Break that lease before another apply." >&2
}

cleanup() {
  release_deploy_lock
  if [[ -n "${BUILD_CONTEXT:-}" ]]; then
    rm -rf "$BUILD_CONTEXT"
    BUILD_CONTEXT=""
  fi
}
trap cleanup EXIT

acquire_deploy_lock() {
  if [[ "$DRY" == "1" ]]; then
    echo "LOCK ${LOCK_BLOB} for the whole ${ENVIRONMENT} apply"
    run_cmd az storage blob lease acquire --subscription "$SUBSCRIPTION" \
      --account-name "$STATE_ACCOUNT" --container-name "$STATE_CONTAINER" \
      --blob-name "$LOCK_BLOB" --lease-duration=-1 --auth-mode login
    note "the lease is released on exit"
    return 0
  fi
  local exists="" id="" blob_file
  if ! exists=$(az storage blob exists --subscription "$SUBSCRIPTION" \
      --account-name "$STATE_ACCOUNT" --container-name "$STATE_CONTAINER" \
      --name "$LOCK_BLOB" --auth-mode login --only-show-errors \
      --query exists --output tsv); then
    echo "Could not read deploy lock ${LOCK_BLOB}. Web and worker were not updated." >&2
    exit 1
  fi
  if [[ "$exists" != "true" ]]; then
    blob_file=$(mktemp)
    printf 'loopiter deploy lock\n' > "$blob_file"
    if ! az storage blob upload --subscription "$SUBSCRIPTION" \
        --account-name "$STATE_ACCOUNT" --container-name "$STATE_CONTAINER" \
        --name "$LOCK_BLOB" --file "$blob_file" --auth-mode login \
        --overwrite false --only-show-errors >/dev/null; then
      rm -f "$blob_file"
      echo "Could not create deploy lock ${LOCK_BLOB}. Web and worker were not updated." >&2
      exit 1
    fi
    rm -f "$blob_file"
  fi
  if ! id=$(az storage blob lease acquire --subscription "$SUBSCRIPTION" \
      --account-name "$STATE_ACCOUNT" --container-name "$STATE_CONTAINER" \
      --blob-name "$LOCK_BLOB" --lease-duration=-1 --auth-mode login \
      --only-show-errors --output tsv); then
    echo "Could not acquire deploy lock ${LOCK_BLOB}. Another apply may be running. Web and worker were not updated." >&2
    exit 1
  fi
  id=${id//$'\r'/}
  if [[ ! "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "Deploy lock ${LOCK_BLOB} returned an unexpected lease id. Web and worker were not updated." >&2
    exit 1
  fi
  LOCK_LEASE=$id
}

reject_image() {
  echo "$1" >&2
  exit 1
}

# Tag or digest from this registry only. Build accepts a tag. Apply pins a tag
# to the digest that registry currently returns.
classify_image() {
  IMAGE_KIND=""
  IMAGE_TAG=""
  IMAGE_DIGEST=""
  if [[ "$IMAGE" == "${IMAGE_PREFIX}@"* ]]; then
    IMAGE_DIGEST=${IMAGE#"${IMAGE_PREFIX}@"}
    if [[ ! "$IMAGE_DIGEST" =~ $DIGEST_RE ]]; then
      reject_image "Image digest must match sha256 and 64 lowercase hex characters."
    fi
    IMAGE_KIND=digest
    return 0
  fi
  if [[ "$IMAGE" == "${IMAGE_PREFIX}:"* ]]; then
    IMAGE_TAG=${IMAGE#"${IMAGE_PREFIX}:"}
    if [[ ! "$IMAGE_TAG" =~ $TAG_RE ]]; then
      reject_image "Image tag must be one registry tag."
    fi
    IMAGE_KIND=tag
    return 0
  fi
  reject_image "Supply ${IMAGE_PREFIX}:TAG or ${IMAGE_PREFIX}@sha256:<64 hex>."
}

pin_image_digest() {
  classify_image
  if [[ "$IMAGE_KIND" == digest ]]; then
    note "apply uses digest ${IMAGE}"
    return 0
  fi
  if [[ "$DRY" == "1" ]]; then
    run_cmd az acr repository show --name "$REGISTRY" --subscription "$SUBSCRIPTION" \
      --image "loopiter:${IMAGE_TAG}" --query digest --output tsv
    note "apply pins ${IMAGE} to its digest before the migration plan"
    return 0
  fi
  local digest=""
  if ! digest=$(az acr repository show --name "$REGISTRY" --subscription "$SUBSCRIPTION" \
      --image "loopiter:${IMAGE_TAG}" --query digest --output tsv --only-show-errors); then
    echo "Could not resolve ${IMAGE} to a digest. Web and worker were not updated." >&2
    exit 1
  fi
  digest=${digest//$'\r'/}
  if [[ ! "$digest" =~ $DIGEST_RE ]]; then
    echo "Registry returned an unexpected digest for ${IMAGE}. Web and worker were not updated." >&2
    exit 1
  fi
  IMAGE="${IMAGE_PREFIX}@${digest}"
  export TF_VAR_image="$IMAGE"
  note "apply uses digest ${IMAGE}"
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

execution_image() {
  local execution=$1
  local found=""
  if ! found=$(az containerapp job execution show --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$JOB" --job-execution-name "$execution" \
      --only-show-errors --query "properties.template.containers[0].image" --output tsv); then
    echo "Could not read the image for migration execution ${execution}. Web and worker were not updated." >&2
    exit 1
  fi
  found=${found//$'\r'/}
  printf '%s' "$found"
}

start_migration_and_wait() {
  if [[ "$DRY" == "1" ]]; then
    run_cmd az containerapp job start --subscription "$SUBSCRIPTION" --resource-group "$RG" --name "$JOB"
    echo "CHECK ${JOB} execution image ${IMAGE}"
    echo "WAIT ${JOB} Succeeded before web and worker"
    return 0
  fi
  local execution="" active="" deadline=$((SECONDS + 2100)) status="" exec_image=""
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
  while (( SECONDS < deadline )); do
    if ! status=$(az containerapp job execution show --subscription "$SUBSCRIPTION" \
        --resource-group "$RG" --name "$JOB" --job-execution-name "$execution" \
        --only-show-errors --query properties.status --output tsv); then
      echo "Could not read migration execution ${execution}. Web and worker were not updated." >&2
      exit 1
    fi
    status=${status//$'\r'/}
    exec_image=$(execution_image "$execution")
    if [[ -n "$exec_image" && "$exec_image" != "$IMAGE" ]]; then
      echo "Migration execution ${execution} is using ${exec_image}, not ${IMAGE}. Web and worker were not updated." >&2
      exit 1
    fi
    case "$status" in
      Succeeded)
        if [[ "$exec_image" != "$IMAGE" ]]; then
          echo "Migration execution ${execution} succeeded without image ${IMAGE}. Web and worker were not updated." >&2
          exit 1
        fi
        return 0
        ;;
      Failed|Degraded|Stopped|Canceled|Cancelled)
        echo "Migration job ${JOB} execution ${execution} is ${status}. Web and worker were not updated." >&2
        exit 1
        ;;
    esac
    sleep 10
  done
  echo "Migration job ${JOB} execution ${execution} timed out after 2100s (last status ${status:-unknown}). Web and worker were not updated." >&2
  exit 1
}

app_image() {
  local app=$1
  local found=""
  if ! found=$(az containerapp show --subscription "$SUBSCRIPTION" \
      --resource-group "$RG" --name "$app" --only-show-errors \
      --query "properties.template.containers[0].image" --output tsv); then
    echo "Could not read the image for ${app}." >&2
    exit 1
  fi
  found=${found//$'\r'/}
  printf '%s' "$found"
}

capture_previous_images() {
  if [[ "$DRY" == "1" ]]; then
    echo "CAPTURE previous images for web-loopiter-${ENVIRONMENT} and worker-loopiter-${ENVIRONMENT}"
    run_cmd az containerapp show --subscription "$SUBSCRIPTION" --resource-group "$RG" \
      --name "web-loopiter-${ENVIRONMENT}" \
      --query "properties.template.containers[0].image" --output tsv
    run_cmd az containerapp show --subscription "$SUBSCRIPTION" --resource-group "$RG" \
      --name "worker-loopiter-${ENVIRONMENT}" \
      --query "properties.template.containers[0].image" --output tsv
    PREV_WEB_IMAGE="<previous-web-image>"
    PREV_WORKER_IMAGE="<previous-worker-image>"
    return 0
  fi
  PREV_WEB_IMAGE=$(app_image "web-loopiter-${ENVIRONMENT}")
  PREV_WORKER_IMAGE=$(app_image "worker-loopiter-${ENVIRONMENT}")
}

roll_back_app() {
  local role=$1 previous=$2
  if [[ -z "$previous" ]]; then
    echo "No previous image for ${role}-loopiter-${ENVIRONMENT}, so it was not restored." >&2
    return 1
  fi
  run_cmd az containerapp update --subscription "$SUBSCRIPTION" --resource-group "$RG" \
    --name "${role}-loopiter-${ENVIRONMENT}" --container-name "$role" --image "$previous"
}

wait_one_app() {
  local role=$1
  local app="${role}-loopiter-${ENVIRONMENT}"
  if [[ "$DRY" == "1" ]]; then
    if [[ "$DRY_FAIL_APP" == "$role" ]]; then
      echo "WAIT ${app} failed image ${IMAGE}"
      return 1
    fi
    echo "WAIT ${app} ready image ${IMAGE}"
    return 0
  fi
  local deadline=$((SECONDS + 600))
  local state="" latest="" serving="" current=""
  while (( SECONDS < deadline )); do
    if ! state=$(az containerapp show --subscription "$SUBSCRIPTION" \
        --resource-group "$RG" --name "$app" --only-show-errors \
        --query '[properties.latestRevisionName,properties.latestReadyRevisionName,properties.template.containers[0].image]' \
        --output tsv); then
      echo "Could not read ${app}." >&2
      return 1
    fi
    latest=$(sed -n '1p' <<< "$state")
    serving=$(sed -n '2p' <<< "$state")
    current=$(sed -n '3p' <<< "$state")
    current=${current//$'\r'/}
    if [[ -n "$latest" && "$latest" == "$serving" && "$current" == "$IMAGE" ]]; then
      return 0
    fi
    sleep 5
  done
  echo "${app} is not serving ${IMAGE} (revision ${latest:-missing}, ready ${serving:-missing}, image ${current:-missing})." >&2
  return 1
}

plan_full() {
  run_cmd terraform -chdir="$ROOT/environment" plan -input=false \
    -var-file="$ROOT/environments/${ENVIRONMENT}.tfvars" -out="$FULL_PLAN"
}

plan_target() {
  local address=$1 plan=$2
  run_cmd terraform -chdir="$ROOT/environment" plan -input=false \
    -var-file="$ROOT/environments/${ENVIRONMENT}.tfvars" \
    -target="$address" -out="$plan"
}

require_plan_only() {
  local plan=$1 address=$2
  if [[ "$DRY" == "1" ]]; then
    run_cmd terraform -chdir="$ROOT/environment" show -json "$plan"
    echo "CHECK targeted plan changes only ${address}"
    return 0
  fi
  terraform -chdir="$ROOT/environment" show -json "$plan" \
    | python3 "$ROOT/migration-plan-guard.py" "$address"
}

apply_migration_then_rollout() {
  pin_image_digest
  acquire_deploy_lock
  plan_target azurerm_container_app_job.migration "$JOB_PLAN"
  require_plan_only "$JOB_PLAN" azurerm_container_app_job.migration
  run_cmd terraform -chdir="$ROOT/environment" apply -input=false "$JOB_PLAN"
  wait_for_job_image
  start_migration_and_wait
  capture_previous_images
  # Worker first. Web is unchanged if this wait fails.
  plan_target azurerm_container_app.worker "$WORKER_PLAN"
  require_plan_only "$WORKER_PLAN" azurerm_container_app.worker
  run_cmd terraform -chdir="$ROOT/environment" apply -input=false "$WORKER_PLAN"
  if ! wait_one_app worker; then
    echo "ROLLBACK worker-loopiter-${ENVIRONMENT} to the previous image"
    roll_back_app worker "$PREV_WORKER_IMAGE" || true
    echo "Worker did not serve ${IMAGE}. Web was not updated." >&2
    exit 1
  fi
  plan_target azurerm_container_app.web "$WEB_PLAN"
  require_plan_only "$WEB_PLAN" azurerm_container_app.web
  run_cmd terraform -chdir="$ROOT/environment" apply -input=false "$WEB_PLAN"
  if ! wait_one_app web; then
    echo "ROLLBACK web-loopiter-${ENVIRONMENT} and worker-loopiter-${ENVIRONMENT} to the previous image"
    roll_back_app web "$PREV_WEB_IMAGE" || true
    roll_back_app worker "$PREV_WORKER_IMAGE" || true
    echo "Web did not serve ${IMAGE}. Both apps were returned to the previous image." >&2
    exit 1
  fi
  plan_full
  run_cmd terraform -chdir="$ROOT/environment" apply -input=false "$FULL_PLAN"
  note "both revisions serve ${IMAGE}"
}

refuse_existing_tag() {
  local tag=$1
  if [[ "$DRY" == "1" ]]; then
    run_cmd az acr repository show --name "$REGISTRY" --subscription "$SUBSCRIPTION" \
      --image "loopiter:${tag}" --query digest --output tsv
    note "build aborts if tag ${tag} already exists"
    return 0
  fi
  local tag_err digest_found=""
  tag_err=$(mktemp)
  if digest_found=$(az acr repository show --name "$REGISTRY" --subscription "$SUBSCRIPTION" \
      --image "loopiter:${tag}" --query digest --output tsv --only-show-errors 2>"$tag_err"); then
    rm -f "$tag_err"
    echo "Tag ${tag} already exists (${digest_found:-unknown}). Refusing to reuse it. Image was not built." >&2
    exit 1
  fi
  if ! grep -Eqi 'not found|manifest unknown|404|could not be found' "$tag_err"; then
    cat "$tag_err" >&2
    rm -f "$tag_err"
    echo "Could not check whether tag ${tag} exists. Image was not built." >&2
    exit 1
  fi
  rm -f "$tag_err"
}

# Build args are only the two values computed here. A dirty tree is refused,
# and the upload is an archive of HEAD rather than the working directory.
build_platform_image() {
  local platform commit built_at dirty=""
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
  if ! dirty=$(git -C "$platform" status --porcelain); then
    echo "Could not read git status in ${platform}. Image was not built." >&2
    exit 1
  fi
  if [[ -n "$dirty" ]]; then
    echo "loopiter-platform checkout has uncommitted or untracked changes. Image was not built." >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi
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
  if [[ ! "$built_at" =~ $UTC_RE ]]; then
    echo "LOOPITER_BUILT_AT must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ. Image was not built." >&2
    exit 1
  fi
  classify_image
  if [[ "$IMAGE_KIND" != tag ]]; then
    echo "Build a new tag. Apply that tag, or its digest, later. Image was not built." >&2
    exit 1
  fi
  BUILD_CONTEXT=$(mktemp -d)
  if ! git -C "$platform" archive HEAD | tar -x -C "$BUILD_CONTEXT"; then
    echo "Could not archive HEAD from ${platform}. Image was not built." >&2
    exit 1
  fi
  if [[ ! -f "$BUILD_CONTEXT/Dockerfile.azure" ]]; then
    echo "Dockerfile.azure is missing from HEAD in ${platform}. Image was not built." >&2
    exit 1
  fi
  if [[ "$DRY" == "1" ]]; then
    echo "DRY-RUN ${ENVIRONMENT} ${IMAGE} build"
    echo "BUILD-ARGS commit=${commit} built_at=${built_at} checkout=${platform}"
    echo "ARCHIVE HEAD ${commit}"
  fi
  refuse_existing_tag "$IMAGE_TAG"
  run_cmd az acr build \
    --subscription "$SUBSCRIPTION" \
    --registry "$REGISTRY" \
    --image "loopiter:${IMAGE_TAG}" \
    --file Dockerfile.azure \
    --build-arg "LOOPITER_COMMIT=${commit}" \
    --build-arg "LOOPITER_BUILT_AT=${built_at}" \
    "$BUILD_CONTEXT"
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
  if [[ "$ACTION" == plan ]]; then
    pin_image_digest
    plan_full
    note "apply locks ${LOCK_BLOB}, migrates, then rolls worker-loopiter-${ENVIRONMENT} before web-loopiter-${ENVIRONMENT}"
  else
    apply_migration_then_rollout
  fi
  exit 0
fi

terraform -chdir="$ROOT/environment" init -input=false -backend-config="$ROOT/environments/${ENVIRONMENT}.backend.hcl"
terraform -chdir="$ROOT/environment" validate
pin_image_digest
if [[ "$ACTION" == plan ]]; then
  plan_full
  note "apply locks ${LOCK_BLOB}, migrates, then rolls worker-loopiter-${ENVIRONMENT} before web-loopiter-${ENVIRONMENT}"
  exit 0
fi
apply_migration_then_rollout
