#!/usr/bin/env bash
# Capture one command with cwd, stdout, stderr, exit code, and timing.
set -euo pipefail

EVIDENCE_INPUT="${1:-}"
LABEL="${2:-}"
CWD_INPUT="${3:-}"
if [[ $# -lt 5 || "${4:-}" != "--" ]]; then
  echo "usage: capture.sh <evidence-dir> <label> <cwd> -- <command> [args...]" >&2
  exit 2
fi
shift 4

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
EVIDENCE="$(cd "$EVIDENCE_INPUT" 2>/dev/null && pwd -P || true)"
CWD="$(cd "$CWD_INPUT" 2>/dev/null && pwd -P || true)"
case "$EVIDENCE" in
  "$REPO_ROOT"/artifacts/verification/*) ;;
  *)
    echo "refusing evidence path outside $REPO_ROOT/artifacts/verification: $EVIDENCE_INPUT" >&2
    exit 1
    ;;
esac
if [[ ! "$LABEL" =~ ^[a-z0-9-]+$ || -z "$CWD" ]]; then
  echo "invalid capture label or cwd" >&2
  exit 2
fi

ACTION_DIR="$EVIDENCE/actions/$LABEL"
mkdir -p "$ACTION_DIR"
printf '%s\n' "$CWD" >"$ACTION_DIR/cwd.txt"
printf '%q ' "$@" >"$ACTION_DIR/command.txt"
printf '\n' >>"$ACTION_DIR/command.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"$ACTION_DIR/started-at.txt"

set +e
(cd "$CWD" && "$@") >"$ACTION_DIR/stdout.txt" 2>"$ACTION_DIR/stderr.txt"
EXIT_CODE=$?
set -e

printf '%s\n' "$EXIT_CODE" >"$ACTION_DIR/exit.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"$ACTION_DIR/finished-at.txt"
printf '%s\n' "$ACTION_DIR"
exit "$EXIT_CODE"
