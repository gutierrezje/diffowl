---
name: verify-diffowl-cli
description: "Verify DiffOwl's local CLI and durable-state behavior through the freshly built binary in a disposable Git repository. Use for changes to setup, backend or model preferences, hooks, findings, worktree state, command parsing, or offline output contracts."
---

# Verify DiffOwl CLI

Prove the changed journey through the built `dist/cli.js` in a disposable Git
repository. Read the [shared evidence contract](../../../skills/verify-diffowl/references/evidence.md),
[features/README.md](features/README.md), then only the selected recipe.

## Workflow

1. Name the changed behavior and expected state, then select its mapped feature.
   Use `cli-version-help` only for a general offline smoke check. For retention,
   migrations, or worktree state, select the durable-state recipe.
2. Discover the current interface with
   `skills/verify-diffowl/control-diffowl cli capabilities --json`.
3. Create the run with `control-diffowl cli new-run <feature-id> --json`, then
   run `control-diffowl cli doctor --run <run-id> --json`.
4. For automated features, execute
   `control-diffowl run cli <feature-id> --run <run-id> --json`. Add `--dry-run`
   first for preference or hook mutations. Drive other recipes manually.
5. Inspect the named receipt. VERIFIED requires both command behavior and the
   resulting file or database state. For interactive or prerequisite-driven
   recipes, follow the manual evidence path in the shared contract; snapshots
   alone leave the controller verdict inconclusive.
6. Recheck run-bound identity, retain evidence, then preview and apply
   `control-diffowl cli cleanup --run <run-id> --dry-run --json`.

Product-state mutation stays inside the recorded scratch. A successful command line alone
is supporting evidence, never the verdict.
