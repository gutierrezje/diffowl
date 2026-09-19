# OpenCode post-commit review

The installed hook queues a commit, returns control promptly, and completes an
OpenCode review for that exact commit in the background.

## Sub-features

- `opencode-hook-review` proves queueing, non-blocking return, exact-commit
  processing, and durable outcome.

## Controller

Use `control-diffowl opencode new-run opencode-hook-review --model
<provider/model>`, then follow the shared manual evidence path. This mapped ID
has no automated driver. `run ... --dry-run` previews controller intent, not the
manual hook actions; `wait-settle` cannot complete a run left in `created` state.
Capture the hook log, terminal outcome, owned-process exit, and manual assessment
directly, and copy evidence before removing the scratch.

The queue assertions also apply to a Codex-backed hook when that is the changed
path. Use a Codex run for disposable setup, name the hook claim separately, and
apply Codex auth and child-teardown checks. There is no `codex-hook-review`
controller ID. Preserve the selected provider throughout the journey.

## How to get to it (user POV)

- Install the hook, then create a commit in the configured repository.
- Inspect the later hook log, report, and findings.

## Driving it with the capture harness

Preconditions:

- The scratch preference selects the explicit OpenCode model.
- The owned server is healthy, and `hook install` is current.

- **Commit.** Add a small code change and commit with signing disabled. Record
  the commit SHA and wall-clock duration; commit should return before review
  completion.
- **Wait.** Wait on a concrete hook-log or queue-result pattern for that SHA, not
  a fixed sleep.
- **Outcome.** Capture `.diffowl/hook.log`, the timestamped report, findings JSON,
  and hook status. Correlate the triggering SHA with the queue result, persisted
  operation/execution, and terminal outcome. The reviewed commit must match even
  if HEAD moves afterward; installed/current hook status is not completion.
- **Cleanup.** Uninstall the hook, stop the owned server, and remove the scratch.

## Gotchas

- A green hook-status command proves installation, not background review
  completion.
- A later commit can queue another review. Keep the recipe to one controlled
  commit.
- Quota, auth, ABI, model, and server failures intentionally stop queue draining;
  preserve the exact classification. When recovery changes, exercise one such
  failure and its supported recovery in the disposable queue. Check which commit
  remains queued, worker exit, and completion without duplicate outcomes after
  the prerequisite is repaired. Separate simulated failure from live evidence.
