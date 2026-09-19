---
name: verify-diffowl-codex
description: "Verify DiffOwl's live Codex App Server review behavior against an exact disposable Git target. Use for Codex runtime or protocol compatibility, model capability routing, policy enforcement, validation or failure persistence, shared review-pipeline changes, repository guards, cancellation, or Codex-backed review output."
---

# Verify DiffOwl Codex

Prove the Codex path through the built DiffOwl binary and its real per-review
App Server child. Read the [shared evidence contract](../../../skills/verify-diffowl/references/evidence.md),
[features/README.md](features/README.md), then only the selected recipe.

## Workflow

1. Choose the claim, feature ID, and explicit bare Codex model. Create it with
   `control-diffowl codex new-run <feature-id> --model <id> --json`. A live run
   may spend model usage.
2. Run `control-diffowl codex doctor --run <run-id> --json`.
   Require the intended source/artifact, Codex CLI, and ChatGPT auth label.
3. For automated features, execute
   `control-diffowl run codex <feature-id> --run <run-id> --model <id> --json`.
   These runs snapshot Git before and after the turn. Drive execution-contract
   recipes manually through the shared evidence path.
4. Inspect `codex receipt --run <run-id> --json` against the selected claim.
   Successful reviews require matching JSON, report, database state, repository
   safety, model provenance, and child teardown. Failure and cancellation recipes
   assert their own terminal outcomes. Manual recipes need a separate assessment.
5. Use `console`, `wait-settle`, and `network-summary` for incomplete runs.
   Cancellation uses a pre-created run and `cancel --run <run-id>` from another
   terminal while `run ... --run <run-id>` is active.
6. Recheck run-bound identity, retain evidence, then dry-run cleanup and remove
   the scratch.

Use existing ChatGPT authentication. Keep account labels non-secret, leave
provider authentication unchanged, and signal only PIDs recorded by the run.
