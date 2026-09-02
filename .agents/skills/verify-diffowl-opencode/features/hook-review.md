# OpenCode post-commit review

The installed hook queues a commit, returns control promptly, and completes an
OpenCode review for that exact commit in the background.

## Sub-features

- `opencode-hook-review` proves queueing, non-blocking return, exact-commit
  processing, and durable outcome.

## Controller

Use `control-diffowl opencode new-run opencode-hook-review --model
<provider/model>`, preview persistent actions with `run ... --dry-run`, then use
`console`, `wait-settle`, `snapshot`, and `receipt` around the recipe below.

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
  and hook status. The recorded reviewed commit equals the commit that triggered
  the run.
- **Cleanup.** Uninstall the hook, stop the owned server, and remove the scratch.

## Gotchas

- A green hook-status command proves installation, not background review
  completion.
- A later commit can queue another review. Keep the recipe to one controlled
  commit.
- Quota, auth, ABI, model, and server failures intentionally stop queue draining;
  preserve the exact classification.
