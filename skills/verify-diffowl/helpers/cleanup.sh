#!/usr/bin/env bash
# Tear down scratch state for a verification run. Keeps evidence/.
set -euo pipefail

RUN_ID="${1:-}"
if [[ -z "$RUN_ID" ]]; then
  echo "usage: cleanup.sh <run-id>" >&2
  exit 2
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="$SKILL_DIR/evidence/$RUN_ID"
PATH_FILE="$EVIDENCE_DIR/scratch.path"

if [[ ! -f "$PATH_FILE" ]]; then
  echo "no scratch.path for run $RUN_ID — nothing to clean" >&2
  exit 0
fi

SCRATCH="$(cat "$PATH_FILE")"

# scratch-repo.sh always creates dirs matching this shape; refuse anything else
# so a corrupted scratch.path can never point rm -rf somewhere unexpected.
if [[ "$SCRATCH" != *"/diffowl-verify-"* ]]; then
  echo "refusing to clean suspicious scratch path: $SCRATCH" >&2
  exit 1
fi

# If this scratch started its own server, stop via recorded PID only.
PID_FILE="$SCRATCH/.diffowl/server.pid"
if [[ -f "$PID_FILE" ]]; then
  PID="$(tr -d '[:space:]' <"$PID_FILE" || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    # Confirm it still looks like opencode before signaling
    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    if [[ "$CMD" == *opencode* ]]; then
      kill "$PID" 2>/dev/null || true
      echo "stopped scratch opencode pid $PID"
    else
      echo "refusing to kill pid $PID (command does not look like opencode): $CMD" >&2
    fi
  fi
fi

if [[ -d "$SCRATCH" ]]; then
  rm -rf "$SCRATCH"
  echo "removed scratch $SCRATCH"
else
  echo "scratch already gone: $SCRATCH"
fi

# Leave evidence/$RUN_ID intact (including scratch.path for audit).
