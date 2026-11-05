#!/usr/bin/env bash
# Shows the archive scan fails closed on a planted key, and warns when gitleaks is absent.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
IMAGE=loopiterregistry7536.azurecr.io/loopiter:scan
FIXTURE=$ROOT/testdata/planted-key.txt

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
platform=$work/platform
mkdir -p "$platform"
git -C "$platform" init -q
git -C "$platform" config user.email test@example.test
git -C "$platform" config user.name test
printf 'FROM scratch\n' > "$platform/Dockerfile.azure"
git -C "$platform" add Dockerfile.azure
git -C "$platform" commit -q -m init

hide_gitleaks() {
  local dir kept=""
  IFS=':' read -r -a entries <<< "${PATH}"
  for dir in "${entries[@]}"; do
    if [[ -z "$dir" || -x "$dir/gitleaks" ]]; then
      continue
    fi
    kept="${kept:+$kept:}$dir"
  done
  printf '%s' "$kept"
}

clean_path=$(hide_gitleaks)
warn_err=$(mktemp)
warn_out=$(PATH="$clean_path" LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$warn_err")
if [[ "$warn_out" != *"acr build"* ]] || ! grep -q 'gitleaks is not installed' "$warn_err"; then
  echo "missing gitleaks must warn and continue" >&2
  printf '%s\n' "$warn_out" >&2
  cat "$warn_err" >&2
  exit 1
fi
rm -f "$warn_err"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed; skipped the planted-key failure check"
  exit 0
fi

cp "$FIXTURE" "$platform/leak.txt"
git -C "$platform" add leak.txt
git -C "$platform" commit -q -m leak
scan_err=$(mktemp)
scan_code=0
scan_out=$(LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$scan_err") || scan_code=$?
if [[ "$scan_code" -eq 0 || "$scan_out" == *"acr build"* ]]; then
  echo "a planted key must stop the build" >&2
  printf '%s\n' "$scan_out" >&2
  cat "$scan_err" >&2
  exit 1
fi
if ! grep -q 'Archive scan failed' "$scan_err"; then
  echo "a planted key must report that the archive scan failed" >&2
  cat "$scan_err" >&2
  exit 1
fi
rm -f "$scan_err"
echo "archive scan ok"
