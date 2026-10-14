#!/usr/bin/env bash
set -euo pipefail
umask 077
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
terraform -chdir="$ROOT/environment" init -input=false -backend-config="$ROOT/environments/$ENVIRONMENT.backend.hcl"
terraform -chdir="$ROOT/environment" validate
terraform -chdir="$ROOT/environment" plan -input=false -var-file="$ROOT/environments/$ENVIRONMENT.tfvars" -out="$ENVIRONMENT.tfplan"
if [[ "$ACTION" == apply ]]; then
  terraform -chdir="$ROOT/environment" apply -input=false "$ENVIRONMENT.tfplan"
  # ARM provisioning can succeed while Azure still serves an older healthy revision.
  for APP in "web-loopiter-$ENVIRONMENT" "worker-loopiter-$ENVIRONMENT"; do
    READY=false
    for ATTEMPT in $(seq 1 120); do
      STATE=$(az containerapp show --subscription d865e614-32e3-4149-860e-36ccec037536 \
        --resource-group "rg-loopiter-$ENVIRONMENT" --name "$APP" \
        --query '[properties.latestRevisionName,properties.latestReadyRevisionName]' --output tsv)
      LATEST=$(head -n 1 <<< "$STATE")
      SERVING=$(tail -n 1 <<< "$STATE")
      if [[ -n "$LATEST" && "$LATEST" == "$SERVING" ]]; then READY=true; break; fi
      sleep 5
    done
    if [[ "$READY" != true ]]; then
      echo "$APP has not activated its new revision. Inspect revision logs; do not declare the rollout complete." >&2
      exit 1
    fi
  done
fi
