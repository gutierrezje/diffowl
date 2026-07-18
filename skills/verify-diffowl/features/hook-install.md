# Feature: Hook install / status

## What it is

Installs DiffOwl's post-commit hook so reviews run after commits (non-blocking).

## How to reach it

From a git repo with a seeded `.diffowl.yml` (use `helpers/scratch-repo.sh`).

## Drive

```bash
export DIFFOWL_BIN=/path/to/diffowl/dist/cli.js
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
EVIDENCE=/path/to/diffowl/skills/verify-diffowl/evidence/$RUN_ID
SCRATCH=$(./skills/verify-diffowl/helpers/scratch-repo.sh "$RUN_ID")
cd "$SCRATCH"

node "$DIFFOWL_BIN" hook install >"$EVIDENCE/stdout-install.txt" 2>"$EVIDENCE/stderr-install.txt"
echo $? >"$EVIDENCE/exit-install.txt"

node "$DIFFOWL_BIN" hook status >"$EVIDENCE/stdout-status.txt" 2>"$EVIDENCE/stderr-status.txt"
echo $? >"$EVIDENCE/exit-status.txt"

cp .git/hooks/post-commit "$EVIDENCE/post-commit.hook"
```

Generating `RUN_ID` upfront and passing it to `scratch-repo.sh` makes the evidence path (absolute, so it survives the `cd`) knowable before the run starts — no reverse lookup needed.

## Observable end state (proof)

- `hook install` exit 0; stdout mentions `Post-commit hook installed`
- `hook status` exit 0; stdout contains `Hook is installed and up to date`
- `.git/hooks/post-commit` exists and contains a DiffOwl-managed section / entrypoint path to `dist/cli.js`
