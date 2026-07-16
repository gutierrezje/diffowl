# Feature: Model preference (scratch only)

## What it is

Sets the local model preference via `diffowl model <provider/model>`.

## How to reach it

**Only inside a scratch repo.** Do not run this in the DiffOwl source checkout (shared preference pollution).

## Drive

```bash
export DIFFOWL_BIN=/path/to/diffowl/dist/cli.js
SCRATCH=$(./skills/verify-diffowl/helpers/scratch-repo.sh)
cd "$SCRATCH"

node "$DIFFOWL_BIN" model opencode-go/deepseek-v4-flash \
  >"$EVIDENCE/stdout.txt" 2>"$EVIDENCE/stderr.txt"
echo $? >"$EVIDENCE/exit.txt"

# Capture wherever preference landed under this cwd
find .diffowl -type f 2>/dev/null | while read -r f; do cp "$f" "$EVIDENCE/$(basename "$f")"; done
```

## Observable end state (proof)

- Exit 0
- stdout contains `Model set to` and `opencode-go/deepseek-v4-flash`
- A preferences file under the scratch `.diffowl/` contains that model (if the resolution writes project-local)

## Do not

- `diffowl model --reset` in the developer checkout
- Interactive `diffowl model` / `diffowl init` (needs TTY)
