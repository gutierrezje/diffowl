# DiffOwl Codex verification map

Use `skills/verify-diffowl/control-diffowl codex capabilities --json` for the
executable inventory. Every live recipe binds a freshly built artifact, exact
disposable Git target, explicit model, current Codex CLI, and ChatGPT auth label.

## Entry-point coverage

| User or protocol entry point | Feature ID |
| --- | --- |
| `diffowl backend codex`, Codex CLI/version/login preflight | `codex-runtime-ready` |
| Default `diffowl review --backend codex` | `codex-review-last-commit` |
| `review --staged --backend codex` | `codex-review-staged` |
| `review --commit <ref> --backend codex` | `codex-review-commit` |
| `review --base <ref> --backend codex` | `codex-review-base` |
| `review --model` and `--reasoning` capability routing | `codex-capability-routing` |
| App Server `thread/start` and `turn/start` read-only policy | `codex-policy-contract` |
| Structured-output retry and terminal failure | `codex-validation-failure` |
| Ctrl+C during an active Codex review | `codex-review-cancel` |

A newly discovered Codex protocol or CLI entry without a row is a coverage gap.

## Proof and cleanup

- Provider-backed runs capture Git state immediately before and after the turn.
- VERIFIED requires structured JSON, immutable report, database state, unchanged
  Git state, requested/effective model evidence, and complete child teardown.
- `console` emits JSON Lines; `wait-settle` and `cancel` use only recorded PIDs.
- Cleanup removes the scratch; Codex has no long-lived server to retain.

## Features

- [Runtime identity](runtime-identity.md): `codex-runtime-ready`.
- [Review targets](review-targets.md): `codex-review-last-commit`,
  `codex-review-staged`, `codex-review-commit`, `codex-review-base`.
- [Execution contract](execution-contract.md): `codex-capability-routing`,
  `codex-policy-contract`, `codex-validation-failure`.
- [Cancellation](cancel-review.md): `codex-review-cancel`.
