#!/usr/bin/env bash
# Archive scan: missing gitleaks aborts, the opt-out warns, a finding aborts.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
IMAGE=loopiterregistry7536.azurecr.io/loopiter:scan
FIXTURE=$ROOT/testdata/planted-key.txt

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
platform=$work/platform
mkdir -p "$platform" "$work/bin"
git -C "$platform" init -q
git -C "$platform" config user.email test@example.test
git -C "$platform" config user.name test
printf 'FROM scratch\n' > "$platform/Dockerfile.azure"
git -C "$platform" add Dockerfile.azure
git -C "$platform" commit -q -m init

mkdir -p "$work/curlbin" "$work/gitleaksbin" "$work/sumbin"
cat > "$work/curlbin/curl" <<'EOF'
#!/bin/sh
echo "simulated download failure" >&2
exit 1
EOF
cat > "$work/gitleaksbin/gitleaks" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "${GITLEAKS_ARGS_FILE:?}"
exit 1
EOF
cat > "$work/sumbin/sha256sum" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod 755 "$work/curlbin/curl" "$work/gitleaksbin/gitleaks" "$work/sumbin/sha256sum"

base_path=$(printf '%s' "$PATH" | tr ':' '\n' | while IFS= read -r dir; do
  [[ -z "$dir" || -x "$dir/gitleaks" ]] && continue
  printf '%s:' "$dir"
done)

miss_err=$(mktemp)
miss_code=0
miss_out=$(PATH="$work/curlbin:$base_path" LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$miss_err") || miss_code=$?
if [[ "$miss_code" -eq 0 || "$miss_out" == *"acr build"* ]]; then
  echo "a failed gitleaks download must stop the build" >&2
  printf '%s\n' "$miss_out" >&2
  cat "$miss_err" >&2
  exit 1
fi
if ! grep -q 'Failed to download gitleaks' "$miss_err"; then
  echo "download failure must name gitleaks" >&2
  cat "$miss_err" >&2
  exit 1
fi
rm -f "$miss_err"

skip_err=$(mktemp)
skip_out=$(PATH="$base_path" LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_SKIP_SECRET_SCAN=1 \
  LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$skip_err")
if [[ "$skip_out" != *"acr build"* ]] || ! grep -q 'LOOPITER_SKIP_SECRET_SCAN=1' "$skip_err"; then
  echo "the opt-out must warn and continue" >&2
  printf '%s\n' "$skip_out" >&2
  cat "$skip_err" >&2
  exit 1
fi
rm -f "$skip_err"

dry_err=$(mktemp)
dry_out=$(PATH="$base_path" LOOPITER_DEPLOY_DRY_RUN=1 LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$dry_err")
if [[ "$dry_out" != *"acr build"* || "$dry_out" != *"secret scan skipped in dry-run"* ]]; then
  echo "dry-run must skip the secret scan and still print the build" >&2
  printf '%s\n' "$dry_out" >&2
  cat "$dry_err" >&2
  exit 1
fi
rm -f "$dry_err"

sum_err=$(mktemp)
sum_code=0
sum_out=$(PATH="$work/sumbin:$base_path" LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$sum_err") || sum_code=$?
if [[ "$sum_code" -eq 0 || "$sum_out" == *"acr build"* ]]; then
  echo "a checksum failure must stop the build" >&2
  printf '%s\n' "$sum_out" >&2
  cat "$sum_err" >&2
  exit 1
fi
if ! grep -q 'Checksum mismatch' "$sum_err"; then
  echo "checksum failure must be reported" >&2
  cat "$sum_err" >&2
  exit 1
fi
rm -f "$sum_err"

args=$work/gitleaks-args
redact_err=$(mktemp)
redact_code=0
GITLEAKS_ARGS_FILE=$args PATH="$work/gitleaksbin:$base_path" LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build >"$work/redact.out" 2>"$redact_err" || redact_code=$?
if [[ "$redact_code" -eq 0 || "$(cat "$work/redact.out")" == *"acr build"* ]]; then
  echo "a gitleaks failure must stop the build" >&2
  cat "$redact_err" >&2
  exit 1
fi
if ! grep -q -- '--redact' "$args"; then
  echo "gitleaks must be called with --redact" >&2
  cat "$args" >&2
  exit 1
fi
rm -f "$redact_err"

if [[ ! -x /tmp/gitleaks && ! -x "$(command -v gitleaks || true)" ]]; then
  echo "archive scan ok"
  exit 0
fi
gitleaks_bin=$(command -v gitleaks || true)
if [[ -x /tmp/gitleaks ]]; then
  gitleaks_bin=/tmp/gitleaks
fi
cp "$FIXTURE" "$platform/leak.txt"
git -C "$platform" add leak.txt
git -C "$platform" commit -q -m leak
find_err=$(mktemp)
find_code=0
find_out=$(PATH="$(dirname "$gitleaks_bin"):$base_path" LOOPITER_PLATFORM_DIR="$platform" \
  "$ROOT/deploy.sh" dev "$IMAGE" build 2>"$find_err") || find_code=$?
if [[ "$find_code" -eq 0 || "$find_out" == *"acr build"* ]]; then
  echo "a planted key must stop the build" >&2
  printf '%s\n' "$find_out" >&2
  cat "$find_err" >&2
  exit 1
fi
if ! grep -q 'Archive scan failed' "$find_err"; then
  echo "a planted key must report that the archive scan failed" >&2
  cat "$find_err" >&2
  exit 1
fi
if grep -q 'k7F3mQ9xL2pR8vN4wY6tB1cH5sD0jUza' "$find_err"; then
  echo "findings must be redacted" >&2
  exit 1
fi
rm -f "$find_err"
echo "archive scan ok"
