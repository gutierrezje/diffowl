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
