# Feature: Hook install / status

## What it is

Installs DiffOwl's post-commit hook so reviews run after commits (non-blocking).

## How to reach it

From a git repo with a seeded `.diffowl.yml` (use `helpers/scratch-repo.sh`).

## Drive

```bash
export DIFFOWL_BIN=/path/to/diffowl/dist/cli.js
SCRATCH=$(./skills/verify-diffowl/helpers/scratch-repo.sh)
cd "$SCRATCH"

node "$DIFFOWL_BIN" hook install >"$EVIDENCE/stdout-install.txt" 2>"$EVIDENCE/stderr-install.txt"
echo $? >"$EVIDENCE/exit-install.txt"

node "$DIFFOWL_BIN" hook status >"$EVIDENCE/stdout-status.txt" 2>"$EVIDENCE/stderr-status.txt"
echo $? >"$EVIDENCE/exit-status.txt"

cp .git/hooks/post-commit "$EVIDENCE/post-commit.hook"
```

Resolve `EVIDENCE` to an **absolute** path before `cd "$SCRATCH"` (relative paths break after the cd):

```bash
RUN_ID=$(basename "$(dirname "$(rg -l -F "$SCRATCH" /path/to/diffowl/skills/verify-diffowl/evidence/*/scratch.path)")")
EVIDENCE=/path/to/diffowl/skills/verify-diffowl/evidence/$RUN_ID
```

Or read `run-id.txt` from the newest evidence dir whose `scratch.path` matches `$SCRATCH`.

## Observable end state (proof)

- `hook install` exit 0; stdout mentions `Post-commit hook installed`
- `hook status` exit 0; stdout contains `Hook is installed and up to date`
- `.git/hooks/post-commit` exists and contains a DiffOwl-managed section / entrypoint path to `dist/cli.js`
