---
name: verify-diffowl-cli
description: "Verify DiffOwl's local CLI and durable-state behavior through the freshly built binary in a disposable Git repository. Use for changes to setup, backend or model preferences, hooks, findings, worktree state, command parsing, or offline output contracts."
---

# Verify DiffOwl CLI

Prove the changed user journey through `dist/cli.js`, not a test helper or a
globally linked binary. Read [features/README.md](features/README.md), then only
the recipes that match the change.

## Workflow

1. Name the affected feature IDs. For a general smoke check, use
   `cli-version-help`.
2. From the DiffOwl root, create a run:

   ```bash
   RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
   SCRATCH="$(./skills/verify-diffowl/helpers/scratch-repo.sh cli <feature-id> "$RUN_ID")"
   EVIDENCE="$(<"$SCRATCH/.diffowl-verify/evidence.path")"
   DIFFOWL_BIN="$PWD/dist/cli.js"
   ```

   The helper builds first and records the source head, dirty-state count,
   binary hash, version, scratch path, and build output.
3. Run `./skills/verify-diffowl/helpers/doctor.sh "$PWD"`. Stop on a binary or
   version mismatch.
4. Drive every command through the capture helper:

   ```bash
   ./skills/verify-diffowl/helpers/capture.sh "$EVIDENCE" <label> "$SCRATCH" -- node "$DIFFOWL_BIN" <args>
   ```

   Inspect both its output and the resulting file or database state. Use the
   CLI-control harness only for the interactive `init` recipe.
5. Keep config, preference, hook, and finding mutations inside the scratch.
   Never run reset, install, or lifecycle commands in the DiffOwl source tree.
6. Run `helpers/cleanup.sh "$EVIDENCE"`. It removes only the recorded scratch
   and retains the proof.

## Result contract

Classify the selected feature as:

- `VERIFIED`: the action and resulting state agree through the captured binary;
- `NOT VERIFIED`: the aligned CLI contradicts the recipe; or
- `INCONCLUSIVE`: the build, binary identity, TTY, prerequisite finding, or
  disposable state could not be established.

A successful build or matching stdout alone is insufficient when the command
promises a file, hook, preference, or database change. Leave this receipt:

```text
target: <source head, dirty-state count, binary hash>
feature: <feature-id>
actions: <captured command directories>
observed: <stdout plus resulting state>
artifacts: <evidence directory>
cleanup: <removed scratch or retained state>
result: VERIFIED | NOT VERIFIED | INCONCLUSIVE
```
