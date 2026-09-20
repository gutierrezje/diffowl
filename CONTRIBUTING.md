# Contributing to DiffOwl

GitHub Issues are the canonical tracker for non-trivial DiffOwl work. Linear is
historical and should not receive new issues.

## From idea to merge

1. Create or claim one GitHub issue with an outcome, reason, acceptance criteria,
   and explicit exclusions.
2. Use one branch and one worktree per active issue. Keep unrelated changes in
   separate worktrees.
3. Open a draft pull request early when feedback on direction or scope would
   prevent rework.
4. Make the smallest coherent change that satisfies the issue.
5. Run focused checks while iterating, then the full checks warranted by the
   change.
6. Run a full-branch DiffOwl review. Fix each finding or record an explicit
   dismissal or deferral with evidence.
7. Complete the pull request template so a reviewer knows where to start, what is
   risky, how the change was verified, and what is intentionally excluded.
8. Merge only after CI is green and every review thread has a disposition.

A tiny, obvious fix may skip the issue and use the pull request as its complete
record.

## Database schema release gate

Keep at most one unreleased database schema version. If the latest published
release uses schema N, ordinary development may use N or N+1. The first schema
change creates N+1; subsequent changes extend that same migration until a release
ships it. A feature PR, merge, or package-version edit does not start another
schema cycle. A release without a schema change consumes no schema number.

Released migrations are immutable. Verify the latest published package/tag
against `src/state/migrations/released-migrations.test.ts`. Run that guard test
with migration verification; it rejects extra schema numbers and migration files.
The release ledger is maintained manually, not discovered from the network by CI.

The maintainer releasing a pending schema must:

1. Confirm the published package version and `gitHead` with `npm view diffowl
   version gitHead --json`, and check the corresponding release tag's schema.
2. Freeze the pending SQL in the release commit. Append its version, intended
   package release, and SHA-256 of the exported SQL to `RELEASED_MIGRATIONS`, and
   advance `LATEST_RELEASED_SCHEMA_VERSION` in the same test file.
3. Run the release guard, fresh-creation tests, and upgrades from the last
   published schema before publishing the package and release tag.
4. Confirm the registry's version and `gitHead` match that release commit before
   starting another schema number. If publication is deferred or fails, keep
   using the pending number and restore the ledger's published boundary for
   ordinary development; release preparation alone does not count as shipping.

A release without schema changes leaves the ledger unchanged.

Test upgrades from the latest released schema into the accumulated unreleased
migration, as well as fresh database creation. An earlier development build may
have used the same number with different SQL: preserve checksum rejection.
Back up or explicitly recreate disposable development state; never rewrite its
migration history or reset an existing user database to make verification pass.

This rule governs SQLite migrations, not JSON/API contract versions or review
policy hashes, whose compatibility identities must change when their semantics
change. See the [durable-state verification recipe](.agents/skills/verify-diffowl-cli/features/durable-state.md).

## Parallel work

Each active issue owns one branch, worktree, and pull request. Do not run two
write-capable agents against the same files or tightly coupled modules. Parallel
investigation is fine; overlapping implementation should be sequenced.

Keep a pull request focused on one outcome. Split it when parts can ship or roll
back independently, require different reviewers, or carry unrelated risk. Keep
the work together when splitting would create an invalid intermediate state or
duplicate the same invariant across multiple pull requests.

## Labels

Use type labels such as `bug`, `enhancement`, `refactor`, `documentation`,
and `research` to describe the work. Integration labels identify the affected
agent surface: `integration:codex`, `integration:cursor`, and
`integration:opencode`.

Workflow labels have precise meanings:

| Label | Meaning |
| --- | --- |
| `needs-triage` | The maintainer has not classified the issue yet. |
| `needs-info` | Work is waiting for evidence or a product answer. |
| `needs-design` | The outcome is known, but the design is not settled. |
| `ready-for-agent` | The issue is specific enough for autonomous execution. |
| `ready-for-human` | Live maintainer judgment or implementation is required. |
| `human-gated` | A measurement or decision must be performed by the maintainer. |
| `blocked` | A named dependency prevents progress. |
| `tracking` | The issue tracks a larger outcome through linked issues. |

Assignment means someone is actively working on the issue. Leave ready backlog
items unassigned so they remain available to claim.

## Pull request standard

A reviewable pull request answers five questions:

1. What outcome does it produce?
2. Where should the reviewer start?
3. What could go wrong?
4. What evidence shows it works?
5. What was deliberately left out?

Review comments are not complete until they have a disposition: fixed, dismissed
with evidence, or deferred to a linked issue. A green check is supporting
evidence, not a substitute for reading the change.
