# Cursor SDK manual verification

Feature IDs: `cursor-sdk-review`, `cursor-sdk-cancel`, `cursor-sdk-auth-status`.
Use the built CLI directly: its command interface supplies the control surface.
There is no Cursor-specific `control-diffowl` adapter yet. Do not substitute the
Codex/OpenCode adapter or claim one of its receipts proves Cursor behavior.

## Preconditions and identity

Build the intended checkout with `pnpm run build`. Record its exact HEAD, dirty
state, Node version, platform, SDK version, and SHA-256 of `dist/cli.js` and
`dist/cursor-worker.js` in the run receipt. Invoke those absolute artifact paths
from a disposable Git repository with hooks disabled. Record fixture ownership.

Use an existing official SDK login or an explicitly supplied `CURSOR_API_KEY`.
`cursor status` must report its source without displaying credentials; `cursor
models` supplies account-specific model IDs. Record the chosen model and the
effective model from review output. Do not record credential contents.

`cursor login` is an interactive prerequisite, not a disposable fixture action:
it creates a named key in the account's SDK credential store. Run it only when
the user intends to sign in; reuse an existing login otherwise.

## Review and persisted state

Create and commit a small correct function, then stage an obvious one-line bug.
Add tracked, untracked, and ignored sentinels and a project Cursor hook that would
create a sentinel if ambient settings were enabled. Snapshot HEAD, status,
staged/worktree binary diffs, and fixture file hashes excluding `.git` and
DiffOwl's own runtime state.

Run the built CLI:

```sh
node /absolute/build/dist/cli.js review --staged --backend cursor \
  --model ACCOUNT_MODEL --format json --fail-on-findings
```

Require valid structured output, the expected finding location, Cursor backend
and observed effective model, and expected exit 1 for findings. Inspect the
persisted report and `findings list --format json`, then repeat the snapshot.
Require identical fixture state and no hook sentinel. Preserve command, output,
timing, snapshots, and an exact-target machine-readable receipt.

## Cancellation

In another disposable fixture, start the built review with the same backend.
Send one SIGINT while the review is active. Require exit 130, no successful
review publication, cancelled durable execution when execution was allocated,
unchanged fixture state, and no surviving worker for that run. Record whether
the cancellation occurred during setup or after the SDK worker started; these
are distinct paths. Deterministic executor tests cover abort-at-start and forced
cleanup races without requiring billed SDK work.

## Cleanup and limits

Remove only the owned fixture and installation after all child processes have
exited. Retain evidence and record removed resources and any running processes
in the receipt. The SDK account login remains intentionally retained.

These checks prove the observed fixture behavior. They do not prove OS
containment, all possible ignored/transient writes, cross-platform SDK behavior,
or improved model review quality. A completed model response is not a successful
review until disposal, process exit, repository validation, and deadline checks
finish. Rejecting an over-deadline or unverifiable result is intentional.
