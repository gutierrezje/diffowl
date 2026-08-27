---
name: verify-diffowl-codex
description: "Verify DiffOwl's live Codex App Server review behavior against an exact disposable Git target. Use for Codex runtime or protocol compatibility, model capability routing, policy enforcement, validation or failure persistence, shared review-pipeline changes, repository guards, cancellation, or Codex-backed review output."
---

# Verify DiffOwl Codex

Prove the Codex path through the freshly built DiffOwl binary and its real
per-review App Server child. Read [features/README.md](features/README.md), then
only the recipes that match the change. Do not use an OpenCode success as a
proxy for this backend.

## Workflow

1. Name the feature IDs and explicit bare Codex model ID. This path may spend
   model usage.
2. Create a scratch with surface `codex`, read its evidence path, and run the
   shared doctor. Record `codex --version` and `codex login status` without
   capturing credentials.
3. Drive the selected recipe with `--backend codex --model <model-id>`. Capture
   JSON, the immutable report, state database, requested and effective models,
   requested reasoning when relevant, session and turn provenance, terminal
   outcome, exit code, and repository snapshots.
4. Confirm every App Server child created by the run exits. DiffOwl has no
   long-lived Codex server to stop; do not signal unrelated Codex processes.
5. Remove the scratch with the shared cleanup and retain evidence.

## Environment and mutation guard

Use the existing ChatGPT-authenticated Codex CLI. `codex login status` is a
preflight, not proof of the child process's account mode. When authentication
changed, require App Server account evidence before the paid turn. Never fall
back to API-key authentication, copy credentials into the scratch, or capture
the child environment.

The scratch is the only mutable repository. Capture tracked and ignored state
before the turn and after the App Server process closes. A final answer is not a
pass if the provider changed the repository or left teardown incomplete.

## Result contract

- `VERIFIED`: the selected path completed on the recorded binary, Codex CLI,
  requested/effective model, and exact Git target with clean teardown;
- `NOT VERIFIED`: the aligned Codex path contradicted the recipe; or
- `INCONCLUSIVE`: login, protocol generation, model capability resolution,
  policy evidence, target identity, cancellation timing, child teardown, or
  artifact capture was unavailable.

Classify protocol, authentication, policy, schema-validation, model-reroute, and
timeout failures separately. Do not collapse them into “Codex failed.” Leave the
standard receipt plus Codex CLI version, auth mode label, requested/effective
model, session/thread IDs, target, repository snapshots, report, and child
cleanup result.
