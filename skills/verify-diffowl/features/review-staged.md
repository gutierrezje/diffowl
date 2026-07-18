# Feature: Staged review (JSON)

## What it is

Runs an AI review of staged changes and emits structured output.

## How to reach it

Scratch repo + tiny staged change. Requires OpenCode + a working model. **Expensive / slow** — use only when the change under test is in the review pipeline.

## Drive

```bash
export DIFFOWL_BIN=/path/to/diffowl/dist/cli.js
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
EVIDENCE=/path/to/diffowl/skills/verify-diffowl/evidence/$RUN_ID
SCRATCH=$(./skills/verify-diffowl/helpers/scratch-repo.sh "$RUN_ID")
cd "$SCRATCH"

# Reuse developer server (port 4096) without auto-starting a second one:
# edit .diffowl.yml server.port to 4096, keep auto_start: false
# OR leave 4197 + auto_start true and record .diffowl/server.pid for cleanup.

printf '%s\n' 'export function add(a: number, b: number) { return a + b }' >src.ts
git add src.ts

node "$DIFFOWL_BIN" review --staged --format json --depth shallow \
  >"$EVIDENCE/review.json" 2>"$EVIDENCE/stderr.txt"
echo $? >"$EVIDENCE/exit.txt"

cp -R .diffowl/reviews "$EVIDENCE/reviews" 2>/dev/null || true
```

## Observable end state (proof)

- Process exits (0 or documented non-zero for empty/skip paths)
- `review.json` parses as JSON (or stderr clearly states skip reason e.g. no changes / doc-only)
- If a review ran: scratch `.diffowl/reviews/latest.md` exists

## Isolation reminder

Never `server stop` on a port you did not start for this run. Prefer `auto_start: false` + existing :4096 for one-shot proofs.
