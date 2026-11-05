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
print("deploy order ok")
PY
