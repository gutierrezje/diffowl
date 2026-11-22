# Cross-backend and native-client verification

Verified 2026-10-28 on macOS arm64; the primary harness used Node 26.4.0. The baseline build was `dist/cli.js` at
`fb1b72a` (SHA-256 `3293933a…`). Tracking issue: #216. This record covers one
synthetic case per backend plus two handoff scenarios per client. It shows that
the three backends work with the same input. It does not benchmark review
quality.

## Same change through three backends

All three backends reviewed the same committed fixture: base `a6f72d4`, head
`f3c6c68`, runtime input SHA-256 `4a82d236…`. The one-line regression changed
`now < expiresAt` to `now <= expiresAt` under a comment that documents strict
expiry. A bundled test fails on the change (`node src/coupon.test.ts` exits 1)
and passes on the base. Each backend ran `review --base main --depth shallow`
once, with a 120-second timeout and the backend's default reasoning. Every lane
received the same context manifest (`83b0d032…`).

The frozen manifest's `d4ad086e…` hash describes trimmed `git diff --binary`
output. DiffOwl includes `--stat --patch`; the exact reviewed bytes are retained
in `runtime-input.diff`. The addendum preserves both representations and proves
the runtime hash agrees with every backend's JSON target.

| Observation                               | Codex                       | Claude                                              | Cursor SDK                                               |
| ----------------------------------------- | --------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| Runtime and model                         | CLI 0.165.0, `gpt-5.6-luna` | Claude Code 2.1.312, `sonnet` → `claude-sonnet-5-5` | `composer-2.5`                                           |
| Expected finding at `src/coupon.ts:3`     | Found                       | Found                                               | Found                                                    |
| Findings                                  | 1                           | 1                                                   | 2 (line 3 error; line 1 warning about the same boundary) |
| Durable review row agrees with JSON       | Yes                         | Yes                                                 | Yes                                                      |
| Tracked, untracked, and ignored sentinels | Unchanged                   | Unchanged                                           | Unchanged                                                |
| Review phase                              | 4.5 s                       | 6.0 s                                               | 14.2 s                                                   |

Every lane exited 1, the expected status for findings, on its first attempt.
An independent judge received anonymous finding sets and the frozen rubric:
each contained one supported defect; Cursor's second finding was redundant.
The successful adapters require provider disposal, process close, and repository
validation. Independent per-child PID sampling was not captured for these three
backend calls. Codex 0.165.0
passed the protocol check before its paid turn, which extends the documented
Codex proof beyond 0.147.0 by one version.

## Native-client handoff

The fixture repaired the regression, verified the reproducer, recorded the
finding as fixed, and installed the managed `AGENTS.md` block, a `CLAUDE.md`
pointer, and an always-applied Cursor rule. Those changes were committed before
the covering checkpoint review. Each client got its own copy of the fixture.
The common prompt began:
"Confirm whether this branch is ready for handoff. Do not modify files."

The successful `native/` trials also specified the absolute checkout binary,
the intended base `main`, and direct commands without shell chaining. These
are assisted compliance checks, not a measurement of unaided instruction
discovery. Codex used authorized workspace-write mode, Claude retained narrow
read/command permissions, and Cursor used authorized Agent mode with its sandbox
and automatic tool review enabled.

Pass criteria were set before the runs. The client must run
`readiness --base main --format json`, start no review or finding update, and
run no mutating command. Its answer must attach the CLI JSON unchanged, match the
CLI verdict, and state the total blocker count. Fixture bytes must not change.

| Scenario                                                                    | Codex 0.165.0 (`codex exec`) | Claude Code 2.1.312 (`claude -p`) | Cursor CLI 2026.08.11 (`cursor-agent -p`, `composer-2.5`) |
| --------------------------------------------------------------------------- | ---------------------------- | --------------------------------- | --------------------------------------------------------- |
| Covered, clean branch: `ready` expected                                     | Pass                         | Pass                              | Pass                                                      |
| Same branch plus an operator's untracked file: `commit-or-restore` expected | Pass                         | Pass                              | Pass                                                      |

All six `native-summary.json` assessments have observed command output matching
the final attached JSON, unchanged fixture content and `.diffowl` state, a
reported blocker total, and a completed client process. The dirty fixture has
zero finding blockers and a separate dirty-worktree reason; each client
preserved that distinction and left the operator file in place.

The original Codex dirty trial attached correct JSON but called the dirty file
"1 blocker" without separately stating the finding total of zero. Its initial
grader also accepted zero from inside the JSON instead of checking the prose.
That failure remains in `native/codex-blocked-coding/`. The generated instructions
now define the four-field finding sum for every result and separate other
readiness reasons. A new instruction-only fixture commit (`0a4a7844…`) received
contiguous repair review coverage. The same Codex scenario then reported
"Finding blockers: 0 total" while preserving the dirty file. This is one observed
repair success, not a guarantee of future instruction compliance.

Supplemental earlier trials in `handoff/` include Cursor runs that omitted
`--base`. This is contract-compliant when the intended local default resolves
to the same OIDs; a grader requiring that flag would produce a false negative.

Cursor ran on `composer-2.5` because the CLI's default Opus model had hit this
account's usage limit. The first CLI login process exited before its browser
step. After a completed sign-in, print mode also needed `--trust` and a model
with remaining quota.

## Hazards found

- **Strict read-only execution can block a read query.** Readiness copies SQLite
  state and WAL into private OS temp storage to avoid repository sidecars.
  Codex's strict read-only mode denied `mkdtemp`; it correctly returned exit 2
  and the client withheld readiness. The implementation now explains the temp
  prerequisite and preserves the original cause. It keeps the existing snapshot
  algorithm and execution-policy boundary.
  SQLite documents the [read-only WAL sidecar requirements](https://www.sqlite.org/wal.html#readonly)
  and the change-detection risks of [immutable database access](https://www.sqlite.org/uri.html#uriimmutable).
  Opening the mutable source as immutable would weaken the existing guarantee.
- **Client launch modes and input streams matter.** Cursor Ask mode refused
  shell commands and correctly withheld readiness. Codex waited on an open
  stdin pipe until the harness closed it. Claude's variadic `--mcp-config`
  consumed a positional prompt without a `--` separator. These failed harness
  attempts are retained. Claude also correctly refused a compound command;
  direct-command guidance resolved that without broadening its permissions.
- **The test runner discovered unrelated worktree copies.** The initial full
  run collected 280 test files, including two `.claude/worktrees` copies.
  The root Vitest configuration now excludes those copies and discovers 94
  files, retaining the package metadata and new snapshot regression tests.
- **Finding totals and readiness reasons can be conflated.** The generated
  handoff block now explicitly defines the finding total as
  `open + regressed + deferred + untracked` for all results. Dirty-worktree and
  operational reasons remain separate, matching the CLI contract.

- **A login shell can run a different binary.** Codex runs commands through
  `zsh -lc`. macOS `path_helper` moves `/opt/homebrew/bin` ahead of a `PATH`
  shim, so Codex ran the installed 0.5.4 release instead of the build under test.
  The Cursor CLI's shell did the same.
  That release uses review policy version 2. The build uses version 3, which #211
  introduced. The release therefore reported `incompatible-policy` with
  `review-branch` for a branch the build reports as ready. Codex and Cursor
  reported that response faithfully. This is intended policy versioning, but it
  means a client shell and the review producer must use the same DiffOwl binary.
  Check the binary from the client's own shell, not only from the harness shell.
- **Cursor CLI status can report a login that print mode rejects.**
  `cursor-agent status` printed "Login successful" while `cursor-agent -p`
  exited with "Authentication required". Treat a successful print-mode probe as
  the authentication check. The Cursor SDK login used by the review backend is a
  separate credential and does not authenticate the CLI.
- **A sandbox can make `init` report a false warning.** When `diffowl init` ran
  inside the previous session's restricted sandbox, it warned "Could not verify
  Codex model". Outside the sandbox, the same build and model passed the check
  without a warning. The warning reflects the sandbox, not the account.

## Remaining uncertainty

- **All client results are headless.** Editor/app UI rule loading was not
  observed. The successful command traces establish this fixture's compliance,
  not that a particular adapter file was necessary for discovery. Ambient
  instructions and effective runtime settings differ; retained commands show
  the configuration actually used.
- **Not-ready actions beyond dirty checkouts are untested in live clients.** No
  client was observed handling `wait`, `review-branch`, `review-uncovered-change`,
  or `disposition-findings`. Deterministic readiness tests cover those
  contracts, not live agent compliance.
- **Optional hooks were not exercised live.** Session-start findings injection
  and background post-commit review were disabled in the native fixtures.
- **Review quality remains unproven.** Each backend ran once on one obvious
  regression. That cannot rank the backends. Cursor's extra finding is a single
  observation of redundant output.
- **Coverage is limited to one machine.** Other platforms, models, and later
  provider versions remain unverified. The documented read-only limits for
  Claude and Cursor still apply.

## Evidence

Raw evidence is local and ignored by Git, under
`artifacts/verification/cross-client-20261028/`. It contains the frozen
`manifest.json`, `manifest-addendum.json`, the exact runtime diff, one assessment
per backend, per-action captures, and blinded adjudication. The six final
headless scenarios are in `native/` with `native-summary.json`; failed launches
and grader corrections remain alongside them. Supplemental earlier trials are
in `handoff/`. The baseline binary hash binds the provider calls and successful
native scenarios; later source changes affect the temp-error diagnostic, test
discovery, and handoff instructions, leaving provider success paths unchanged.
The Codex instruction treatment and final temp-diagnostic receipt bind their
own newer binary hashes separately.

The corrected full suite passed 1,187 tests with 7 skipped; lint/typecheck and
build passed. The original restricted runs failed on denied localhost listeners
and nested-worktree collection; those failures are separate from provider
compatibility. The focused snapshot regression verifies normal reads and
preservation of source bytes when temporary storage is unavailable.
After the instruction repair, all 32 focused integration/snapshot checks and
lint/typecheck passed. All four verification skill packages passed the bundled
skill validator. Native Codex structural review found no executable-design
issues; its documentation sequencing finding was corrected.
The offline verification-controller suite also passed all 24 tests with normal
localhost access.

The experiment-owned repositories were removed after retaining synthetic Git
bundles, report/state copies, and receipts. The approved Cursor SDK and Agent
logins remain active. The implementation changes are local and uncommitted;
its readiness query reports `dirty-worktree`, with zero finding blockers.
The repeatable procedure is the CLI skill's
[cross-client recipe](../../.agents/skills/verify-diffowl-cli/features/cross-client.md).
