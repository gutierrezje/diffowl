---
name: verify-diffowl-codex
description: "Verify DiffOwl's live Codex App Server review behavior against an exact disposable Git target. Use for Codex runtime or protocol compatibility, model capability routing, policy enforcement, validation or failure persistence, shared review-pipeline changes, repository guards, cancellation, or Codex-backed review output."
---

# Verify DiffOwl Codex

Prove the Codex path through the built DiffOwl binary and its real per-review
App Server child. Read [features/README.md](features/README.md), then only the
selected recipe. An OpenCode result is not Codex evidence.

## Workflow

1. Choose a feature ID and explicit bare Codex model. A live run may spend model
   usage.
2. Run `skills/verify-diffowl/control-diffowl codex doctor --model <id> --json`.
   Require the intended source/artifact, Codex CLI, and ChatGPT auth label.
3. Execute `control-diffowl run codex <feature-id> --model <id> --json`.
   Provider-backed runs snapshot Git immediately before and after the turn.
4. Inspect `receipt --run <run-id> --json`. VERIFIED requires structured output,
   immutable report, database state, unchanged repository, requested/effective
   model provenance, and zero live owned children.
5. Use `console`, `wait-settle`, and `network-summary` for incomplete runs.
   Cancellation uses a pre-created run and `cancel --run <run-id>` from another
   terminal while `run ... --run <run-id>` is active.
6. Dry-run cleanup, then remove the scratch and retain evidence.

Use existing ChatGPT authentication. Keep account labels non-secret, leave
provider authentication unchanged, and signal only PIDs recorded by the run.
