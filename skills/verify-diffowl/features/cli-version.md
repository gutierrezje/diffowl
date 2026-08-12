# Feature: CLI version

## What it is

Reports the installed DiffOwl version.

## How to reach it

Built binary: `dist/cli.js` after `pnpm run build`.

## Drive

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
EVIDENCE=/path/to/diffowl/skills/verify-diffowl/evidence/$RUN_ID

node /path/to/diffowl/dist/cli.js -V >"$EVIDENCE/stdout.txt" 2>"$EVIDENCE/stderr.txt"
echo $? >"$EVIDENCE/exit.txt"
```

## Observable end state (proof)

- Exit 0
- stdout is a semver matching `package.json` `"version"` (e.g. `0.3.2`)
