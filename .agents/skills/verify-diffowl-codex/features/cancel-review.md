# Cancel a Codex review

Cancellation lets a user press Ctrl+C while a Codex turn is active and requires
an acknowledged interrupt, terminal interrupted state, clean child exit, and an
unchanged repository.

## Sub-features

- `codex-review-cancel` proves the complete active-turn interruption and teardown
  path.

## How to get to it (user POV)

- Start a Codex review in a terminal and press Ctrl+C while the turn is active.

## Driving it with the CLI-control harness

Preconditions:

- ChatGPT login and protocol compatibility are healthy.
- The scratch has a nontrivial staged code change and a captured repository
  snapshot.

- **Launch.** Start the review in tmux or a PTY and wait for a concrete active
  review progress message.
- **Interrupt.** Send one Ctrl+C. Capture the terminal through DiffOwl's final
  cancellation message and process exit.
- **Teardown.** Confirm the turn acknowledged interruption, reached a terminal
  interrupted state, closed the protocol stream, and left no attributable App
  Server child.
- **Safety.** Capture the post-close repository snapshot. No tracked or ignored
  source mutation is allowed beyond expected DiffOwl state.

## Gotchas

- If the turn finishes before interruption, report `INCONCLUSIVE` for this
  feature.
- A killed wrapper process does not prove the App Server acknowledged interrupt.
- Capture post-close state; a snapshot taken before child teardown misses
  close-time mutations.
