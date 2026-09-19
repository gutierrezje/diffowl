---
name: verify-diffowl-opencode
description: "Verify DiffOwl's live OpenCode server and review behavior against an exact disposable Git target. Use for OpenCode transport, server lifecycle, model/provider integration, shared review-pipeline changes, cancellation, or provider-backed hook reviews."
---

# Verify DiffOwl OpenCode

Prove the OpenCode path through the built DiffOwl binary and a server owned by
one disposable run. Read the [shared evidence contract](../../../skills/verify-diffowl/references/evidence.md),
[features/README.md](features/README.md), then only the selected recipe.

## Workflow

1. Choose the claim, feature ID, and explicit `provider/model` for live review.
   Create it with `control-diffowl opencode new-run <feature-id> --model
   <provider/model> --json`. Live review paths may spend model usage; server-only
   lifecycle checks need no model.
2. Run `control-diffowl opencode doctor --run <run-id> --json` and inspect the
   effective binary, CLI, reserved port,
   and non-secret auth label.
3. Execute `control-diffowl run opencode <feature-id> --run <run-id> --model
   <provider/model> --json`. Automated paths own server start, PID capture, and
   stop. For recipe-driven hook work, use the shared manual evidence path.
4. Inspect the receipt plus `network-summary` and `wait-settle`. VERIFIED requires
   the selected recipe's outcome. Successful reviews require the exact target,
   structured output, immutable report, database, repository safety, and complete
   server/review teardown; lifecycle and cancellation have their own assertions.
5. For cancellation, create the run first, start it with `--run <run-id>`, and
   issue `cancel` from another terminal. Only the recorded process group is
   signalled.
6. Recheck run-bound identity, retain evidence, then dry-run cleanup and remove
   the recorded scratch.

Use existing provider authentication. A missing `effective_model` limits the
identity claim to the requested route; it never proves the provider's underlying
model. The adapter never reuses or stops an unowned server.
