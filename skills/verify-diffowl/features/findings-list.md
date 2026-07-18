# Feature: Findings list (empty)

## What it is

Lists unresolved durable findings from `.diffowl/state.db`.

## How to reach it

Scratch repo with seeded config (no prior reviews → empty list).

## Drive

```bash
export DIFFOWL_BIN=/path/to/diffowl/dist/cli.js
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
EVIDENCE=/path/to/diffowl/skills/verify-diffowl/evidence/$RUN_ID
SCRATCH=$(./skills/verify-diffowl/helpers/scratch-repo.sh "$RUN_ID")
cd "$SCRATCH"

node "$DIFFOWL_BIN" findings list --format json >"$EVIDENCE/findings.json" 2>"$EVIDENCE/stderr.txt"
echo $? >"$EVIDENCE/exit.txt"
```

## Observable end state (proof)

- Exit 0
- JSON has `schema_version: 1`, `count: 0`, `findings: []`
