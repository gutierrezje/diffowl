#!/usr/bin/env bash
# Tear down one recorded verification scratch. Keep its evidence.
set -euo pipefail

EVIDENCE_INPUT="${1:-}"
if [[ -z "$EVIDENCE_INPUT" ]]; then
  echo "usage: cleanup.sh <absolute-evidence-directory>" >&2
  exit 2
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
EVIDENCE_DIR="$(cd "$EVIDENCE_INPUT" 2>/dev/null && pwd -P || true)"
case "$EVIDENCE_DIR" in
  "$REPO_ROOT"/artifacts/verification/*) ;;
  *)
    echo "refusing evidence path outside $REPO_ROOT/artifacts/verification: $EVIDENCE_INPUT" >&2
    exit 1
    ;;
esac
PATH_FILE="$EVIDENCE_DIR/scratch.path"

if [[ ! -f "$PATH_FILE" ]]; then
  echo "no scratch.path in $EVIDENCE_DIR — nothing to clean" >&2
  exit 0
fi

SCRATCH="$(cat "$PATH_FILE")"
SCRATCH="$(cd "$SCRATCH" 2>/dev/null && pwd -P || true)"
if [[ -z "$SCRATCH" ]]; then
  printf '%s\n' "cleanup=already-absent" >>"$EVIDENCE_DIR/receipt.txt"
  echo "scratch already gone or unreachable — nothing to clean"
  exit 0
fi
if [[ "$(basename "$SCRATCH")" != diffowl-verify-* ]]; then
  echo "refusing to clean suspicious scratch path: $SCRATCH" >&2
  exit 1
fi

# Stop only a server whose PID was recorded by this scratch.
PID_FILE="$SCRATCH/.diffowl/server.pid"
if [[ -f "$PID_FILE" ]]; then
  PID="$(tr -d '[:space:]' <"$PID_FILE" || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    if [[ "$CMD" == *opencode* ]]; then
      kill "$PID" 2>/dev/null || true
      for _ in {1..50}; do
        if ! kill -0 "$PID" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "$PID" 2>/dev/null; then
        echo "scratch opencode pid $PID did not stop; keeping scratch for inspection" >&2
        exit 1
      fi
      echo "stopped scratch opencode pid $PID"
    else
      echo "refusing to kill pid $PID (command does not look like opencode): $CMD" >&2
      echo "keeping scratch for inspection" >&2
      exit 1
    fi
  fi
fi

rm -rf "$SCRATCH"
printf '%s\n' "cleanup=removed-scratch" "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$EVIDENCE_DIR/receipt.txt"
echo "removed scratch $SCRATCH"

# Leave the evidence directory intact, including scratch.path for audit.
