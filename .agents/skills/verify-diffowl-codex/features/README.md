# DiffOwl Codex verification map

Every recipe uses a freshly built DiffOwl artifact, an exact disposable Git
target, an explicit model, and the real local Codex App Server integration.

## Baseline preconditions

- `codex` is installed and `codex login status` reports ChatGPT authentication.
- The scratch receipt identifies the binary and source state under test.
- Capture Codex CLI version before every live run; compatibility is checked
  against the current generated protocol, not inferred from an old evidence run.

## Proof and cleanup

- Capture commands, JSON, immutable report, state, requested/effective models,
  session/thread provenance, repository snapshots, and child teardown.
- Keep every attempt separate.
- Remove the scratch; no long-lived Codex server should remain.

## Features

- [Runtime identity and compatibility](runtime-identity.md):
  `codex-runtime-ready`.
- [Review targets](review-targets.md): `codex-review-staged`,
  `codex-review-commit`, `codex-review-base`.
- [Execution contract](execution-contract.md): `codex-capability-routing`,
  `codex-policy-contract`, `codex-validation-failure`.
- [Cancellation and teardown](cancel-review.md): `codex-review-cancel`.
