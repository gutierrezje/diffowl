#!/usr/bin/env bash
# Read-only readiness check for DiffOwl verification.
set -euo pipefail

ROOT="${1:-.}"
ROOT="$(cd "$ROOT" && pwd)"
BIN="$ROOT/dist/cli.js"
FAILED=0

ok() { printf '✓ %s\n' "$*"; }
bad() { printf '✗ %s\n' "$*"; FAILED=1; }
info() { printf '· %s\n' "$*"; }

NODE_VER="$(node -v 2>/dev/null || true)"
if [[ -z "$NODE_VER" ]]; then
  bad "node not on PATH"
else
  # Require >= 22.14.0 (engines field)
  MAJOR="$(echo "$NODE_VER" | sed -E 's/^v([0-9]+).*/\1/')"
  MINOR="$(echo "$NODE_VER" | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')"
  if (( MAJOR > 22 || (MAJOR == 22 && MINOR >= 14) )); then
    ok "node $NODE_VER"
  else
    bad "node $NODE_VER is below 22.14.0"
  fi
fi

if [[ -f "$BIN" ]]; then
  VER="$(node "$BIN" -V 2>/dev/null || true)"
  if [[ -n "$VER" ]]; then
    ok "diffowl CLI $VER ($BIN)"
  else
    bad "dist/cli.js present but -V failed — run pnpm run build"
  fi
else
  bad "missing $BIN — run pnpm run build"
fi

if command -v opencode >/dev/null 2>&1; then
  ok "opencode on PATH ($(opencode --version 2>/dev/null || echo unknown))"
else
  bad "opencode not on PATH (required for review / init model query)"
fi

if [[ -f "$ROOT/.diffowl.yml" ]]; then
  PORT="$(node -e "
    const fs=require('fs'); const t=fs.readFileSync(process.argv[1],'utf8');
    const m=t.match(/port:\\s*(\\d+)/); process.stdout.write(m?m[1]:'4096');
  " "$ROOT/.diffowl.yml" 2>/dev/null || echo 4096)"
else
  PORT=4096
fi

SERVER_STATUS_FILE="$(mktemp "${TMPDIR:-/tmp}/diffowl-doctor-server.XXXXXX")"
trap 'rm -f "$SERVER_STATUS_FILE"' EXIT
# Run from $ROOT so the CLI resolves the same .diffowl.yml as the port hint.
if (cd "$ROOT" && node "$BIN" server status) >"$SERVER_STATUS_FILE" 2>&1; then
  info "server status: $(tr '\n' ' ' <"$SERVER_STATUS_FILE")"
else
  info "server status non-zero (ok for offline features): $(tr '\n' ' ' <"$SERVER_STATUS_FILE")"
fi
info "configured/default port hint: $PORT (do not stop a server you did not start)"

exit "$FAILED"
