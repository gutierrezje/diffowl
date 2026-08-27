#!/usr/bin/env bash
# Build the checkout, bind evidence to that artifact, and create a scratch repo.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
SURFACE="${1:-}"
FEATURE="${2:-}"
RUN_ID="${3:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

if [[ ! "$SURFACE" =~ ^[a-z0-9-]+$ || ! "$FEATURE" =~ ^[a-z0-9-]+$ ]]; then
  echo "usage: scratch-repo.sh <surface> <feature-id> [run-id]" >&2
  exit 2
fi
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid run id: $RUN_ID" >&2
  exit 2
fi

BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/diffowl-verify-build-${RUN_ID}-XXXXXX")"
trap 'rm -rf "$BUILD_TMP"' EXIT

set +e
(cd "$REPO_ROOT" && pnpm run build) >"$BUILD_TMP/build.stdout.txt" 2>"$BUILD_TMP/build.stderr.txt"
BUILD_EXIT=$?
set -e
if (( BUILD_EXIT != 0 )); then
  FAILED_DIR="$REPO_ROOT/artifacts/verification/build-failed/$SURFACE/$FEATURE/$RUN_ID"
  mkdir -p "$FAILED_DIR"
  mv "$BUILD_TMP/build.stdout.txt" "$BUILD_TMP/build.stderr.txt" "$FAILED_DIR/"
  printf '%s\n' "$BUILD_EXIT" >"$FAILED_DIR/build.exit.txt"
  echo "build failed; evidence: $FAILED_DIR" >&2
  exit "$BUILD_EXIT"
fi

BIN="$REPO_ROOT/dist/cli.js"
HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
BIN_HASH="$(git -C "$REPO_ROOT" hash-object "$BIN")"
STATUS="$(git -C "$REPO_ROOT" status --porcelain=v1)"
PORT="$(node -e 'const net=require("node:net"); const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port); server.close();});')"
TARGET="${HEAD:0:12}"
if [[ -n "$STATUS" ]]; then
  TARGET="$TARGET-dirty-${BIN_HASH:0:12}"
fi

EVIDENCE_DIR="$REPO_ROOT/artifacts/verification/$TARGET/$SURFACE/$FEATURE/$RUN_ID"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/diffowl-verify-${RUN_ID}-XXXXXX")"
mkdir -p "$EVIDENCE_DIR"
mv "$BUILD_TMP/build.stdout.txt" "$BUILD_TMP/build.stderr.txt" "$EVIDENCE_DIR/"
printf '%s\n' "$BUILD_EXIT" >"$EVIDENCE_DIR/build.exit.txt"
printf '%s\n' "$SCRATCH" >"$EVIDENCE_DIR/scratch.path"
printf '%s\n' "$RUN_ID" >"$EVIDENCE_DIR/run-id.txt"
printf '%s\n' "$STATUS" >"$EVIDENCE_DIR/target-status.txt"

cd "$SCRATCH"
git init -q --initial-branch=main
git config user.email "verify@diffowl.local"
git config user.name "DiffOwl Verify"
printf '%s\n' "# verify scratch" >README.md
printf '%s\n' ".diffowl/" >.gitignore

# Non-interactive project policy. Provider recipes set an explicit model and
# decide whether to start the reserved dedicated port.
cat >.diffowl.yml <<YAML
server:
  port: $PORT
  auto_start: false
context:
  depth: shallow
retention:
  hook_log_kb: 512
gate:
  fail_on_findings: false
timeout: 120
min_confidence: medium
include:
  - "**/*"
exclude: []
rules: []
skip_doc_only: false
verbose: false
YAML

mkdir -p .diffowl .diffowl-verify
cat >.diffowl/preferences.yml <<'YAML'
backend: opencode
models:
  - backend: opencode
    model: provider/model
YAML
printf '%s\n' "$EVIDENCE_DIR" >.diffowl-verify/evidence.path

git add README.md .gitignore .diffowl.yml
git -c commit.gpgsign=false commit -qm "verify: initial state"

cat >"$EVIDENCE_DIR/receipt.txt" <<EOF
surface=$SURFACE
feature=$FEATURE
run_id=$RUN_ID
source_head=$HEAD
source_status_entries=$(printf '%s\n' "$STATUS" | sed '/^$/d' | wc -l | tr -d ' ')
binary=$BIN
binary_hash=$BIN_HASH
binary_version=$(node "$BIN" -V)
package_version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$REPO_ROOT/package.json")
node=$(node -v)
reserved_port=$PORT
scratch=$SCRATCH
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cleanup=pending
EOF

# stdout contract: only the scratch path.
printf '%s\n' "$SCRATCH"
