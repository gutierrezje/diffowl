# Cursor ACP adapter

This module owns DiffOwl's native Cursor integration. Users select it with
`diffowl backend cursor`; OpenCode remains the backward-compatible default.

## Execution contract

`createCursorReviewExecutor` implements the review-owned `ReviewExecutor`
interface. One execution does the following in order:

1. Starts one `cursor-agent acp` child in the repository.
2. Initializes ACP protocol version 1 while declaring filesystem reads,
   filesystem writes, and terminal access unavailable through client
   capabilities.
3. Authenticates through Cursor's existing `cursor_login` session and starts a
   fresh session without MCP servers.
4. Requires the requested base model to appear in Cursor's model picker, applies
   an advertised reasoning variant when requested, and switches the session to
   read-only `ask` mode.
5. Sends the shared marker-based review prompt. Invalid closed review documents
   get at most two retries, for three total attempts.
6. Allows only one-shot read, search, or thinking permissions and rejects
   write, execute, external fetch, and unsupported blocking server requests.
7. Verifies repository state after every turn and again after process close.
8. Closes stdin and escalates through `SIGTERM` and `SIGKILL` within a bounded
   teardown window, then verifies that the child PID is gone.

Cancellation sends ACP `session/cancel` before bounded teardown. The adapter
does not use Cursor's unrestricted print mode or grant filesystem, terminal, or
MCP capabilities.

## Model and reasoning selection

Cursor's ordinary CLI model list uses flattened parameterized IDs, while ACP
selects a base model and then exposes its parameters separately. Use
`diffowl model --list` to query ACP base IDs, save one with
`diffowl model <model-id>`, and configure reasoning independently. DiffOwl
applies a saved reasoning variant only when Cursor advertises that exact value.
Unsupported variants produce a warning and use Cursor's backend default.

## Verification

```bash
pnpm run test:cursor
pnpm run lint
```

The automated suite drives a real child process that implements the ACP
boundary and covers success, validation retry, permission denial, cancellation,
timeout, reasoning fallback, and repository mutation. Live provider proof is a
separate human/account-backed check so the normal suite cannot spend Cursor
usage.
