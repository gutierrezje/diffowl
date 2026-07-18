---
name: verify-diffowl
description: "Drive DiffOwl's real CLI the way a user does — build the binary, doctor the instance, exercise hooks/findings/review in an isolated scratch git repo, and capture evidence. Use when proving DiffOwl CLI behavior, verifying a change end-to-end, or when unit tests alone are not enough."
---

# Verify DiffOwl

DiffOwl is a **CLI** (no web UI). Proof means: build → doctor → drive a user-facing command in an **isolated scratch git repo** → capture stdout/files/exit codes → clean up the scratch without deleting evidence.

Agents: read this cold. Prefer the helpers under `helpers/`. Never treat Vitest mocks as proof of user-facing behavior.

## Isolation (read first)

- The developer's DiffOwl checkout often has a live OpenCode server on **port 4096**. Do **not** run `diffowl server stop` against it, and do **not** kill `opencode` by process name.
- Always drive mutable flows (`hook`, `findings`, config writes, reviews) inside a scratch repo from `helpers/scratch-repo.sh`. Never install hooks or rewrite `.diffowl.yml` in the DiffOwl source tree as part of verification.
- `diffowl model <id>` and `diffowl model --reset` write the **shared local preference** (`.diffowl/preferences.yml` under the cwd's DiffOwl dir resolution). Only run those inside a scratch repo, or skip them.
- `diffowl init` requires an interactive TTY for model selection. For non-interactive proof, seed `.diffowl.yml` yourself (the scratch helper does this).
- Two LLM reviews against the shared server can contend. Prefer offline features for routine proof. When reviewing, set `server.auto_start: false` in the scratch config and reuse the already-running server **only for read/review**, or use a dedicated port + `auto_start: true` in the scratch and tear that server down by **the PID you started**, never by name.

## Launch

There is no long-lived DiffOwl daemon to keep up for most proofs. "Launch" means build the CLI once:

```bash
cd /path/to/diffowl
pnpm run build
BIN="$(pwd)/dist/cli.js"   # or: which diffowl  (must resolve to this build)
```

Ready when: `node "$BIN" -V` prints a semver (e.g. `0.3.2`).

For a review that needs OpenCode: `node "$BIN" server status` should show running, **or** the scratch config may auto-start on its own port (see Isolation).

Teardown of the binary itself: nothing. Teardown of scratch state: `helpers/cleanup.sh` (see Cleanup).

## Doctor

Run before driving when anything looks off:

```bash
./skills/verify-diffowl/helpers/doctor.sh /path/to/diffowl
```

Doctor is **read-only**. It checks Node ≥ 22.14, `dist/cli.js` exists and reports a version, and (informational) whether `opencode` is on PATH and whether something answers on the configured server port. Non-zero exit means do not drive until fixed; a missing `opencode` is only a warning (offline features still work, review features won't).

## Drive

1. Create a scratch repo (prints its path on stdout; also writes a run marker):

```bash
SCRATCH=$(./skills/verify-diffowl/helpers/scratch-repo.sh)
export DIFFOWL_BIN=/path/to/diffowl/dist/cli.js
```

2. `cd "$SCRATCH"` and run the feature recipe from `features/`. Prefer `--format json` when available so evidence is machine-checkable.

3. Capture evidence into the run directory named by the scratch helper (also echoed). See Evidence.

Stable handles (use these, not fuzzy prose matching):

| Surface | Handle |
| --- | --- |
| Version | `node $DIFFOWL_BIN -V` → semver string, exit 0 |
| Hook status | stdout contains `Hook is installed and up to date` or structured failure reason |
| Findings list | `--format json` → `schema_version`, `count`, `findings` |
| Review | `--format json` → review document / findings array; also `.diffowl/reviews/latest.md` in the scratch |
| Server status | `✓ Server running on port …` or not-running message |

## Evidence

Proof artifacts live under:

```text
skills/verify-diffowl/evidence/<run-id>/
```

Minimum for a valid proof:

- `meta.json` — run id, feature id, git commit of DiffOwl under test, commands, exit codes, timestamps
- `stdout.txt` / `stderr.txt` — captured command output
- Side-effect proof for the feature (e.g. `post-commit` hook file, findings JSON, review markdown)

Standards:

- Exercise the **real CLI path** (`node dist/cli.js …`), not internal test helpers or mocked `runReview`.
- Capture the **action and resulting state** (exit code + file/JSON change), not only a success spinner line.
- Mocks only at production boundaries (e.g. you may skip a live LLM review when proving hook install).

## Cleanup

```bash
./skills/verify-diffowl/helpers/cleanup.sh <run-id>
```

Removes only scratch repos and temp dirs **this run created** (paths recorded under `evidence/<run-id>/scratch.path`). Does **not** delete `evidence/<run-id>/`. Does **not** stop the developer's OpenCode server.

If a failed iteration started an OpenCode server on a scratch-dedicated port, kill that server with the PID recorded in the scratch's `.diffowl/server.pid` (if present), then run cleanup.

## Helpers

| Script | Purpose |
| --- | --- |
| `helpers/doctor.sh <repo-root>` | Read-only readiness check |
| `helpers/scratch-repo.sh [run-id]` | Create isolated git repo + seeded `.diffowl.yml`; prints scratch path |
| `helpers/cleanup.sh <run-id>` | Remove scratch for that run; keep evidence |

All helpers are executable. Invoke them from the DiffOwl repo root unless noted.
