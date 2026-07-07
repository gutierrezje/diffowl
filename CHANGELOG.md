# Changelog

All notable changes to DiffOwl are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

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

[0.3.2]: https://github.com/gutierrezje/diffowl/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gutierrezje/diffowl/releases/tag/v0.3.1
