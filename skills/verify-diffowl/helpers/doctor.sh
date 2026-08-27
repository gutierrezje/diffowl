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
  PACKAGE_VER="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$ROOT/package.json" 2>/dev/null || true)"
  if [[ -z "$VER" ]]; then
    bad "dist/cli.js present but -V failed — run pnpm run build"
  elif [[ "$VER" != "$PACKAGE_VER" ]]; then
    bad "dist/cli.js reports $VER but package.json reports $PACKAGE_VER — rebuild"
  else
    BIN_HASH="$(git -C "$ROOT" hash-object "$BIN")"
    ok "diffowl CLI $VER ($BIN, artifact $BIN_HASH)"
  fi
else
  bad "missing $BIN — run pnpm run build"
fi

for RUNTIME in opencode codex; do
  if command -v "$RUNTIME" >/dev/null 2>&1; then
    info "$RUNTIME on PATH ($("$RUNTIME" --version 2>/dev/null || echo unknown))"
  else
    info "$RUNTIME not on PATH"
  fi
done

HEAD="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo non-git)"
STATUS_COUNT="$(git -C "$ROOT" status --porcelain=v1 2>/dev/null | wc -l | tr -d ' ')"
info "source target: $HEAD ($STATUS_COUNT working-tree entries)"

exit "$FAILED"
