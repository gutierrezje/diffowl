---
name: verify-diffowl-cli
description: "Verify DiffOwl's local CLI and durable-state behavior through the freshly built binary in a disposable Git repository. Use for changes to setup, backend or model preferences, hooks, findings, worktree state, command parsing, or offline output contracts."
---

# Verify DiffOwl CLI

Prove the changed journey through the built `dist/cli.js` in a disposable Git
repository. Read [features/README.md](features/README.md), then only the selected
recipe.

## Workflow

1. Confirm the entry point maps to a feature ID. Use `cli-version-help` for a
   general offline smoke check.
2. Discover the current interface with
   `skills/verify-diffowl/control-diffowl cli capabilities --json`.
3. Run `control-diffowl cli doctor --json`; stop on source/artifact mismatch.
4. Execute `control-diffowl run cli <feature-id> --json`. Add `--dry-run` first
   for setup, preference, hook, or finding mutations.
5. Inspect the named receipt. VERIFIED requires both command behavior and the
   resulting file or database state. For interactive or prerequisite-driven
   recipes, use `cli new-run`, follow the recipe inside that scratch, then use
   `snapshot` and `receipt`.
6. Run `control-diffowl cli cleanup --run <run-id> --dry-run --json`, then apply
   cleanup. Evidence remains.

All mutation stays inside the recorded scratch. A successful command line alone
is supporting evidence, never the verdict.
