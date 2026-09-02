---
name: verify-diffowl-opencode
description: "Verify DiffOwl's live OpenCode server and review behavior against an exact disposable Git target. Use for OpenCode transport, server lifecycle, model/provider integration, shared review-pipeline changes, cancellation, or provider-backed hook reviews."
---

# Verify DiffOwl OpenCode

Prove the OpenCode path through the built DiffOwl binary and a server owned by
one disposable run. Read [features/README.md](features/README.md), then only the
selected recipe.

## Workflow

1. Choose a feature ID and explicit `provider/model`. Live review paths may
   spend model usage.
2. Run `skills/verify-diffowl/control-diffowl opencode doctor --model
   <provider/model> --json` and inspect the effective binary, CLI, reserved port,
   and non-secret auth label.
3. Execute `control-diffowl run opencode <feature-id> --model <provider/model>
   --json`. The adapter owns server start, PID capture, review, and stop.
4. Inspect the receipt plus `network-summary` and `wait-settle`. VERIFIED requires
   the exact target, structured output, immutable report, database, unchanged Git
   state, and complete server/review teardown.
5. For cancellation, create the run first, start it with `--run <run-id>`, and
   issue `cancel` from another terminal. Only the recorded process group is
   signalled.
6. Dry-run cleanup, then remove the recorded scratch and retain evidence.

Use existing provider authentication. A missing `effective_model` limits the
identity claim to the requested route; it never proves the provider's underlying
model. The adapter never reuses or stops an unowned server.
