# DiffOwl OpenCode verification map

Use `skills/verify-diffowl/control-diffowl opencode capabilities --json` for the
executable inventory. Every live recipe uses an explicit provider/model and a
dedicated server PID and port owned by its disposable run.

## Entry-point coverage

| User entry point | Feature ID |
| --- | --- |
| Default `diffowl review --backend opencode` | `opencode-review-last-commit` |
| `review --staged --backend opencode` | `opencode-review-staged` |
| `review --commit <ref> --backend opencode` | `opencode-review-commit` |
| `review --base <ref> --backend opencode` | `opencode-review-base` |
| `review --model provider/model` and `--reasoning` routing | Corresponding OpenCode review-target feature |
| `diffowl server start|status|stop` and auto-start | `opencode-server-owned-lifecycle` |
| Ctrl+C during an active OpenCode review | `opencode-review-cancel` |
| Installed Git post-commit hook and background worker | `opencode-hook-review` |

A newly discovered OpenCode command, server path, or hook entry without a row is
a coverage gap.

## Proof and cleanup

- Provider runs capture requested route, JSON, report, database, PID, port, Git
  state, and teardown. Missing effective-model evidence limits the identity claim.
- `network-summary` inspects only the reserved port and recorded server PID.
- `cancel` signals only a recorded process group; cleanup uses the existing
  PID-checked helper and retains evidence.

## Features

- [Review targets](review-targets.md): `opencode-review-last-commit`,
  `opencode-review-staged`, `opencode-review-commit`, `opencode-review-base`.
- [Server lifecycle](server-lifecycle.md): `opencode-server-owned-lifecycle`.
- [Cancellation](cancel-review.md): `opencode-review-cancel`.
- [Post-commit review](hook-review.md): `opencode-hook-review`.
