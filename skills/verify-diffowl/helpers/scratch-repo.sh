#!/usr/bin/env bash
# Create an isolated git repo with a seeded DiffOwl config for verification drives.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
RUN_ID="${1:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
EVIDENCE_DIR="$SKILL_DIR/evidence/$RUN_ID"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/diffowl-verify-${RUN_ID}-XXXX")"

mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$SCRATCH" >"$EVIDENCE_DIR/scratch.path"
printf '%s\n' "$RUN_ID" >"$EVIDENCE_DIR/run-id.txt"

cd "$SCRATCH"
git init -q
git config user.email "verify@diffowl.local"
git config user.name "DiffOwl Verify"
printf '%s\n' "# verify scratch" >README.md
git add README.md
git commit -qm "verify: initial commit"

# Non-interactive config: dedicated high port, no auto-start (won't steal/kill :4096).
cat >.diffowl.yml <<'YAML'
model: opencode-go/deepseek-v4-flash
server:
  port: 4197
  auto_start: false
context:
  depth: shallow
reasoning:
  effort: auto
timeout: 120
min_confidence: medium
include:
  - "**/*"
exclude:
  - "**/node_modules/**"
  - "**/dist/**"
rules: []
skip_doc_only: false
verbose: false
YAML

cat >"$EVIDENCE_DIR/meta.partial.json" <<EOF
{
  "run_id": "$RUN_ID",
  "scratch": "$SCRATCH",
  "diffowl_repo": "$REPO_ROOT",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# stdout contract: only the scratch path (agents capture this)
printf '%s\n' "$SCRATCH"
