# Cancel an OpenCode review

Cancellation lets a user press Ctrl+C, stop the active review, and regain a
clean terminal without leaving a misleading report or mutated repository.

## Sub-features

- `opencode-review-cancel` interrupts an in-flight review and settles its server
  session and local state.

## How to get to it (user POV)

- Start a review in a terminal and press Ctrl+C while progress is visible.

## Driving it with the CLI-control harness

Preconditions:

- The owned server is healthy, the explicit model resolves, and the scratch has
  a nontrivial staged code change.
- Capture repository state before launch.

- **Launch.** Start the staged JSON review in tmux or a PTY rooted at the scratch.
  Capture the screen after a concrete review-progress message.
- **Interrupt.** Send one Ctrl+C. Wait for the cancellation message and process
  exit; record the actual exit code and terminal transcript.
- **Settle.** Capture server status and any session/report state after exit. No
  successful review may be inferred from a partial JSON fragment or spinner.
- **Safety.** Capture repository state again and confirm the provider path did
  not change it. Stop the owned server during cleanup.

## Gotchas

- If the review completes before Ctrl+C, the cancellation feature is
  `INCONCLUSIVE`, not verified.
- A wrapper timeout can preempt DiffOwl's own cancellation path. Record which
  deadline fired.
- Do not treat a closed terminal alone as acknowledged cancellation; capture the
  CLI's terminal outcome and server settlement.
