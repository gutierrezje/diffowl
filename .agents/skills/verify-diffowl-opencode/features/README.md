# DiffOwl OpenCode verification map

Every recipe uses a freshly built DiffOwl artifact, a disposable Git repo, an
explicit provider/model, and a dedicated OpenCode server owned by the run.

## Baseline preconditions

- `opencode` is installed and the selected provider is already authenticated.
- The scratch receipt supplies a reserved port and exact binary identity.
- Start the server from the scratch; do not reuse a long-lived developer server.
- The selected model resolves on the owned server before the paid action.

## Proof and cleanup

- Capture commands, JSON, report files, PID, port, server/CLI versions, and Git
  state under the run evidence directory.
- Record every paid attempt separately.
- Stop only the recorded server and remove the scratch; retain evidence.

## Features

- [Review targets](review-targets.md): `opencode-review-staged`,
  `opencode-review-commit`, `opencode-review-base`.
- [Server lifecycle](server-lifecycle.md): `opencode-server-owned-lifecycle`.
- [Cancellation](cancel-review.md): `opencode-review-cancel`.
- [Post-commit review](hook-review.md): `opencode-hook-review`.
