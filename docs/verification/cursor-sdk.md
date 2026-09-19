# Cursor SDK adapter verification

Verified 2026-09-19 on macOS arm64, Node 22.14.0, with `@cursor/sdk` 1.0.31
and account model `composer-2.5`. This records implementation verification,
not a review-quality benchmark or a cross-platform certification.

## Automated checks

- `pnpm run lint`: passed, including TypeScript and generated lint-plugin checks.
- `pnpm run build`: passed; package contains the CLI, worker, and shared chunks.
- Full suite with Git signing disabled: 86 files passed, 4 skipped;
  1,073 tests passed, 7 skipped (1,080 total).
- Frozen lockfile validation: passed.
- CLI verification recipe `cli preference-select`: VERIFIED; disposable state
  cleaned up. Cursor-specific CLI tests also preserve other backend preferences
  and verify that authentication status does not display an environment key.
- Fifteen Cursor executor tests exercise real child processes: success, invalid
  output, unexpected tools, abnormal exit, post-result data, cancellation,
  timeout, repository mutation, environment filtering, temporary-store cleanup,
  and surviving-descendant rejection. These use a synthetic worker and do not
  establish live SDK behavior by themselves.

## Live built and installed CLI

Both runs used a disposable Git repository with one staged bug:
`price * (1 - percent / 100)` changed to `price * (1 + percent / 100)`.
The fixture included tracked, untracked, and ignored sentinels plus a Cursor
project hook that would create a file if ambient hooks ran.

```sh
diffowl review --staged --backend cursor --model composer-2.5 \
  --format json --fail-on-findings
```

| Observation | Built CLI | Fresh npm package installation |
| --- | --- | --- |
| Seeded bug at `price.js:2` | Found | Found |
| Findings | 1 | 1 |
| Backend / effective model | cursor / composer-2.5 | cursor / composer-2.5 |
| Exit status | 1, expected for findings | 1, expected for findings |
| HEAD, index, worktree, fixture file hashes | Unchanged | Unchanged |
| Review and findings persisted | Yes | Yes |
| Elapsed single run | 8.996 s | 8.570 s |

The installed run used `npm pack`, a fresh installation with package scripts
disabled, and the installed `dist/cli.js`. The existing official SDK login was
used; no credentials are included in these artifacts. Auth status and model
catalog commands were also exercised live. Fixture repositories were removed.

## Scope and limits

The SDK is configured with `read`, `grep`, `glob`, and `ls`; shell, MCP, and task
tools are excluded. Ambient settings are disabled. The worker awaits SDK
disposal and the parent verifies exit and repository state before accepting a
review. The independent structural audit found no remaining scoped blockers.

This is a tool policy, not OS containment, read-path isolation, or network
isolation. The production guard does not detect every ignored or transient
write. Parent-side Git/hash work and final temporary-store removal are not
fully cancellable. Live Windows/Linux SDK runs and reasoning overrides are
outside this verification. Authentication uses the SDK's separate key flow;
Cursor CLI authentication is not reused.

## Review follow-up

The independent Codex review of implementation commit `9b27088` found that
discarding thinking events could make active reasoning appear stalled in
execution telemetry. The repair routes these events through the same
content-free activity notification as other provider events. Focused lifecycle
and telemetry tests passed (20 tests), followed by lint/typecheck and rebuild.
The full-suite and live-package results above cover the implementation before
this one-line telemetry repair; no SDK policy or lifecycle behavior changed.

## Hosted-review lifecycle repair

Windows CI exposed a setup timeout returning while repository snapshot work
still held the fixture directory. Setup and final-check races now drain their
snapshot operation before returning. Abort/deadline checks prevent worker
startup after setup cancellation. Cleanup errors retain an existing failure
and attach cleanup detail as its cause instead of changing cancellation or
timeout into a generic failure.

Regression coverage includes no worker start after cancellation, snapshot work
settled before cancellation returns, and cancellation preserved when the final
snapshot exceeds its cleanup deadline. All 17 Cursor tests pass. The integrated
full suite passed 1,075 tests with 7 skipped; lint and build also passed.

The rebuilt CLI completed another live `composer-2.5` review in 9.850 seconds,
found the seeded bug, persisted it, and preserved fixture state. A separate live
SIGINT run observed the SDK worker before cancellation, exited 130 in 1.794
seconds, persisted a cancelled execution, preserved fixture state, and left no
worker. Both fixtures were removed. The first cancellation harness attempt read
stdout instead of the CLI's JSON error stream; correcting the harness to inspect
stderr produced the passing result, without a product change.

Rejecting a response when post-run validation or the total deadline fails remains
intentional: a model response alone does not establish a successful review.

Both repair reviewers identified that draining alone could wait indefinitely.
The follow-up gives repository capture an optional abort signal, forwards it to
Git subprocesses and file-reading streams, and waits for all started operations
to settle. Cursor cancels setup capture with the review and applies a separate
deadline to final capture. Inspection disables Git fsmonitor and textconv
helpers. Other callers may continue to omit the signal.

The final follow-up passed 30 focused guard/lifecycle tests, lint, build, and the
full suite (1,077 passed, 7 skipped). Fresh built-CLI live runs again preserved
all fixture state: review found the seeded bug in 10.998 seconds; cancellation
exited 130 in 2.001 seconds with a durable cancelled execution and no surviving
worker. Fixtures were removed. This cancels Git and streamed reads; it does not
turn uninterruptible operating-system metadata calls into a hard real-time
guarantee.
