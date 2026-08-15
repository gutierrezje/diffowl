# Changelog

All notable changes to DiffOwl are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Added

- `diffowl init` prompts whether to add a managed DiffOwl section to `AGENTS.md` and whether to install the Claude Code session-start findings hook.

## [0.4.0] - 2026-08-14

The **Reliable Review Automation** release. DiffOwl now carries findings across
reviews more reliably, repairs malformed review output in-session, and can gate
pre-PR workflows on unresolved findings.

### Added

- Aggregate `diffowl findings summary` output for findings reachable from the
  current checkout. Staged summaries include only findings whose reviewed diff
  still matches; `--format json` provides machine-readable output and `--all`
  includes findings outside the reachable history.
- Opt-in review gate: `--fail-on-findings` or `gate.fail_on_findings` exits 1
  when unsuppressed error or warning findings remain.

### Changed

- Finding identity is now file plus quoted evidence. Findings without quoted
  evidence remain visible but are untracked and cannot be dismissed, deferred,
  or merged.
- Review JSON is now schema version 2, with null `id` and `fingerprint` values
  for untracked findings and `classification: "untracked"`.
- Invalid or missing-marker review documents are repaired in the same session;
  after three total attempts, DiffOwl throws instead of silently dropping
  findings.
- Reports are stored as uniquely timestamped files. `latest` and `latest.md`
  resolve to the newest report instead of relying on a mutable `latest.md` copy.

### Fixed

- Untracked findings now appear in JSON and participate in review status and
  gate decisions.
- Completed JSON reviews wait for stdout to flush before exiting, preventing
  truncated output when a gate fails.
- `FINAL_REVIEW_JSON` is recognized only as a standalone line, so marker text
  inside JSON content cannot corrupt document extraction.
- Findings summaries are fail-silent and time-bounded; session-start logs are
  capped so Git, SQLite, or slow diff-driver failures cannot break startup.
- Claude settings reconciliation now removes duplicate DiffOwl entries and
  writes `.claude/settings.json` atomically.

### Experimental

- Opt-in Claude Code SessionStart integration via
  `diffowl agent-hook install --client claude` surfaces aggregate findings
  summaries on startup and resume. This is an install-only preview; check and
  uninstall commands are not yet available.

## [0.3.3] - 2026-07-15

The **Branch Review** release. DiffOwl can now review everything a branch
adds — the same diff a pull request shows — instead of one commit at a time.

### Added

- **Branch review: `diffowl review --base [ref]`.** Reviews the committed
  changes since the merge base with the given ref (three-dot semantics).
  Omit the ref to auto-detect the default branch. Reviews committed `HEAD`
  only, so results are reproducible; `--staged` remains the pre-commit
  surface. This is the natural pre-PR review for agent-driven workflows,
  where a session produces many commits and the unit that matters is the
  branch delta.
- **`diffowl findings list --format json`** for scripts and agents.

### Changed

- **`info` findings are now advisory.** A review whose only findings are
  `info`-severity reports status `Advisory` (JSON: `"advisory"`) instead of
  `Open`. Only `error` and `warning` findings open a review. Info findings
  still receive durable ids and appear in `diffowl findings`.
- **Model selection is developer-local.** The active model now lives in
  local state rather than the shared `.diffowl.yml`, so teammates (and
  worktrees) can use different models without dirtying the committed config.
  Explicit config values are validated (empty models rejected).

### Fixed

- `latest.md` is written atomically, eliminating corruption when reviews
  from linked worktrees finish concurrently; temp files are cleaned up if
  the rename fails.
- Shared state-root lookups are hardened and retried, fixing crashes on
  partial git failures.
- Review snapshots persist their commit identity correctly.

### Internal

- Review pipeline extracted from the CLI into `src/review/run.ts`
  (plan 018): skip paths, happy path, rendering, and timing ownership now
  live behind one callable pipeline — groundwork for MCP and CI surfaces.
- Eval: corpus expectation contract enforced by a conformance test
  (plan 027); first post-contract live baseline captured
  (`eval/baselines/v3`, deepseek-v4-flash); gates documented as opt-in
  comparison tooling, not run verdicts.
- Retired the legacy `dogfood:0.3` manual release-gate script and checklist now
  that durable-finding coverage lives in deterministic tests and the eval
  corpus.

## [0.3.2] - 2026-07-07

The **Measured Review Quality** release. DiffOwl now measures its own review
precision and recall against a labeled corpus, so quality changes are made on
evidence instead of intuition. The first user-visible result is a less biased
reviewer prompt; the measurement machinery itself is internal tooling.

### Changed

- **Reviews are less biased toward CLI-specific concerns.** The reviewer prompt
  was over-weighting command-line-tool patterns; findings are now more evenly
  relevant across project types (web apps, libraries, services), not just CLIs.
- **Durable finding state is now shared across linked git worktrees.** Reviews
  and the findings backlog anchor to your repository's primary checkout, so all
  linked worktrees see one backlog instead of fragmented per-worktree state.
  Checkout-scoped runtime files (hook status, hook log, `server.pid`) stay local
  to each checkout.

### Fixed

- **Corrected the default model name** written and documented in configuration
  from `opencode-go/big-pickle` to `opencode/big-pickle`. The previous value did
  not resolve against OpenCode, so fresh setups using the default failed to run
  reviews until the model was changed manually.
- **OpenCode server startup is more robust.** DiffOwl now guards against starting
  on an already-occupied port and tolerates an unhealthy listener that disappears
  mid-startup, instead of failing the review.
- **Usage and cost data is preserved on the review result**, so per-review model
  usage is reported reliably.

### Internal

- Added a replayable **evaluation harness** (internal `diffowl eval`) that scores
  reviews for precision, recall, repeated false positives, latency, and cost
  against a 14-case labeled corpus of bug-introducing and clean changes, with
  cross-run baseline comparison and regression gates. The first live baseline is
  captured and committed. This is internal tooling per the roadmap and is not yet
  a supported public command; it exists so future prompt and context changes can
  be validated before shipping.
- Cross-platform (Windows) test stabilization, platform-independent corpus
  hashing, typecheck heap headroom, and dogfood setup hardening.

## [0.3.1]

See the Git history and release notes for versions at and before `v0.3.1`.

[0.4.0]: https://github.com/gutierrezje/diffowl/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/gutierrezje/diffowl/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/gutierrezje/diffowl/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gutierrezje/diffowl/releases/tag/v0.3.1
