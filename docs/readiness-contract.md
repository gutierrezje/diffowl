# Review readiness, version 1

Status: accepted on 2026-09-19. Tracks #96, #91, and #90. This document describes a local readiness
proof, not GitHub approval or permission to merge.

## Question and boundary

For this exact resolved base, merge base, committed HEAD, and review policy, is
there complete compatible review coverage with no unhandled actionable findings?

`diffowl readiness [--base <ref>] [--format text|json]` answers without starting a
review, loading a model runtime, contacting a forge, changing findings, cleaning
runtime files, creating state, or migrating a database. It does not report a
cached readiness flag. The shared application service owns the calculation;
terminal and JSON output project the same result.

The base defaults to the same local default-branch resolution used by branch
reviews. Explicit refs resolve once to immutable commit IDs. No fetch occurs.
Changing the resolved base invalidates a proof even when the merge base stays
the same. A readiness query on an unborn branch is an operational error.

## Coverage policy

A complete successful branch review is a checkpoint. Exact commit reviews can
extend it through a contiguous first-parent chain, provided each repair is
compatible with the checkpoint's review policy. Every intervening commit must
be covered. A merge commit uses the existing first-parent review semantics.
When no chain is complete, report the compatible chain with the fewest uncovered
commits so the next action does not request already covered work.
Rebases and rewritten history cannot reuse a disconnected checkpoint. Staged
reviews and isolated commit reviews cannot establish a branch checkpoint.

Coverage records must establish the reviewed input and effective review policy;
older reviews without sufficient evidence remain inspectable but cannot prove
readiness. Policy identity includes review scope, rules, confidence filtering,
context depth, and the review-contract version. Transport, model choice,
credentials, local server ports, retention, verbosity, and presentation flags do
not enter the provider-neutral readiness domain.

Provider execution success alone is insufficient: a canonical review must have
been durably published, have accountable findings, and have acceptable input
evidence. Skipped, failed, timed-out, cancelled, malformed, or incompletely
persisted attempts do not establish coverage. Intentional policy exclusions
must be distinguished from collection failures and truncated review inputs.

Input policy version 2 permits intentional limits on supplemental excerpts:
related files, rendered file copies, and AST symbols (including shallow-depth
symbol selection). Their truncation/omission counts remain in the captured
context manifest. A shortened full-file copy that is not rendered is not missing
review input. The complete changed diff is required; truncated changed hunks,
unavailable changed files, parser/index collection failures, and other unaccepted
degradations still prevent complete coverage. This interpretation changes the
policy hash; older reviews are not upgraded.

A successful newer compatible attempt can replace a failed attempt at the same
input. An unresolved newer failure must not be hidden behind an older successful
proof. A newly running attempt likewise prevents handoff until its outcome is
known. Old failure history remains evidence; it is never deleted by a query.
Replacement evidence includes compatible publications outside the selected
coverage chain. A manual retry can supersede a hook failure, but a remaining
hook marker still represents queued work and prevents handoff.

## Branch policy changes

Status: accepted on 2026-11-02. Tracks #215.

Readiness evaluates coverage against the review policy read from the working
tree. A branch controls that file, so an agent could add `exclude` globs, drop
`rules`, or lower `min_confidence`, run one full review under the looser policy,
and obtain `ready`. Policy identity alone cannot catch this, because the review
and the query agree with each other.

Readiness therefore also computes the policy hash from `.diffowl.yml` at
`target.merge_base_commit` (a base without the file means the defaults) with the same `reviewPolicySha256` used for coverage, over the whole
effective policy, so new policy knobs are covered when they enter that hash. The base
side uses the depth its own config selects; the branch side uses the `--depth` value or
its configured depth, so choosing a shallower depth by flag is also a policy change. The
base config is the nearest `.diffowl.yml` walking up from the directory the command was
invoked from (not from the discovered project root) to the repository root, the same
start point the working tree uses to discover its project root. When the two hashes
differ, the proof is `not-ready` with reason `policy-changed-on-branch` and next action
`acknowledge-policy-change`, until a matching acknowledgement exists. The gate applies
to an otherwise ready result; higher-priority reasons still report first, and
`policy_change` stays visible while they are repaired. Legitimate policy changes are
not forbidden: they need a person's decision. Edits that do not alter the effective
policy (comments, `timeout`, `server`) do not trigger it.

An unparseable `.diffowl.yml` at the base (including one the current schema no longer
accepts, such as a key removed by a later DiffOwl version) is never read as the default
policy and does not make readiness an error, which would deadlock a branch that repairs
it. Its identity is `invalid:` followed by the SHA-256 of the file's bytes, so it always
differs from a real policy and requires the same acknowledgement.

### Why non-ready with a terminal acknowledgement

A ready result plus a `policy_changed_on_branch` diagnostic was rejected. Agents are
told to hand off when exit 0 and `ready` hold, and a diagnostic on a ready result is
exactly the field an automation or an agent summarizing its work drops. The failure
mode is silent: the loosened gate looks identical to a passing one. A non-ready
reason fails closed for every consumer that follows `next_action`, including older
clients that do not know the new value.

Making it non-ready needs a way out, otherwise legitimate policy changes could never
be handed off. The acknowledgement is keyed on the pair (base policy hash, branch policy
hash), so it approves one decision and any further policy edit invalidates it. The base
commit is deliberately not part of the key: a fetch that moves the base without changing
either policy keeps the decision. `diffowl policy accept` prints the differing policy
fields, named as in `.diffowl.yml`, and requires the user to type `accept`. The
readiness diagnostic prints the exact command, `diffowl policy accept --base <OID>` from
`target.base_commit`, plus `--depth <depth>` when the query used `--depth`. It refuses
unless both stdin and stdout are a terminal, which stops the ordinary agent path of
running a shell command with piped I/O.

Limits, stated plainly: this is friction against an agent that follows its
instructions, not a security boundary. The acknowledgement is stored as
`policy-acknowledgements.json` in the shared DiffOwl state directory (the same
directory as the state database, outside the committed tree), and a process with
write access to that directory or a pseudo-terminal could forge or satisfy it. The
managed AGENTS.md block and the handoff workflow tell agents not to. Forge-side
protection (for example reading policy from a protected default branch in CI) remains
the stronger control and is outside this local contract. Replacing the working-tree
policy with the base policy remains out of scope.

### Contract and schema

`schema_version` stays 1. The change is additive: a new `policy_change` field (`null`
when the base policy equals `policy_sha256`, otherwise `{ "base_policy_sha256": string,
"acknowledged": boolean }`; the branch side is `policy_sha256`), plus a new reason and next
action. Consumers are already required to
treat an unknown action or version as no proof, so an older client fails closed
instead of reading the new state as ready. The meaning of `ready` is unchanged and a
ready result continues to carry every earlier field. When not acknowledged, the
diagnostic names both hashes and the exact acknowledgement command.

## Finding and worktree policy

Actionable means warning or error after the review's confidence policy. Relevant
findings with open, regressed, or deferred status block readiness. Fixed and
dismissed findings do not block; informational findings do not block. Actionable
output without durable identity blocks because its disposition cannot be proved.
Version 1 preserves its count and cannot record a lifecycle disposition for an
untracked concern; a later omission does not clear that blocker.
Finding relevance includes merged side-branch commits, while coverage repairs
follow the first-parent chain. Absence from a later review never resolves a
finding. Possible-duplicate suggestions have no lifecycle effect until explicitly confirmed.

Inspect observations within the branch's coverage/history, not the global
`last_review_id` pointer: another worktree can move that pointer. Reuse the
existing file-plus-evidence fingerprints and authoritative lifecycle events.
Do not change identity, infer a disposition, or silently drop unresolved
findings by choosing a more convenient review.

Tracked modifications, staged changes, submodule changes, and non-ignored
untracked files prevent ready. Ignored files are outside this Git cleanliness
claim. Readiness reports the committed identity even when dirty, but does not
extend the proof to those local edits. It cannot prove the absence of transient
or ignored writes during a review.

## State and next-action matrix

Exit 0 means ready; exit 1 means a derived not-ready result; exit 2 means the
query could not establish a trustworthy result. JSON contains no timestamps or
random IDs generated by the query, so stable inputs produce byte-equivalent
output. Errors remain distinct from a missing review and never become an empty
successful result.

| Input | Reason | Next action | Exit |
| --- | --- | --- | --- |
| State database absent | missing-review | full branch review | 1 |
| Only staged or commit reviews | incomplete-coverage | full branch review | 1 |
| Disconnected checkpoint or moved base | incompatible-lineage | full branch review | 1 |
| Policy differs or historical evidence insufficient | incompatible-policy | full branch review | 1 |
| Branch policy differs from the merge base's and is not acknowledged | policy-changed-on-branch | ask the user to run `diffowl policy accept` | 1 |
| HEAD advanced with an uncovered repair | stale-coverage | review uncovered change | 1 |
| Review queued or running for relevant work | review-pending | wait and query again | 1 |
| Relevant attempt failed without a later successful replacement | review-failed | inspect failure and retry | 1 |
| Local Git changes | dirty-worktree | commit or restore local changes | 1 |
| Unhandled actionable findings | finding-blocked | inspect and disposition findings | 1 |
| Complete compatible current coverage, clean checkout, no blockers | ready | hand off | 0 |
| Git, config, SQLite, or runtime-state read failure | operational-error | repair the named dependency | 2 |
| Older database schema | operational-error | explicitly migrate with a write command | 2 |
| Newer or incompatible database schema | operational-error | use a compatible DiffOwl build | 2 |

Operational errors take precedence over all derived results. The result should
retain independent blocker counts and coverage facts rather than discard them
when another condition supplies the primary reason. Pending work takes priority
over starting duplicate reviews. Dirty work precedes reviewing a new snapshot.

The versioned JSON includes result, reason, next action, resolved base/merge-base/
head, coverage checkpoint and ordered repair review IDs, policy identity, any branch policy change, and
blocking finding counts, worktree cleanliness, and uncovered commit IDs. An operational error includes a bounded diagnostic and
any identity already resolved; it contains no reassuring `ready` state.

## Persistence and runtime ownership

Current `review_operations` already owns resolved `base_commit`,
`merge_base_commit`, `head_commit`, and `diff_hash`; `reviews.targetCommit` is a
projection of `head_commit`. Preserve these facts and existing IDs. Add only the
missing compatibility facts; do not create a parallel review history or store
derived current/stale/superseded/ready flags.

Completed evidence and finding lifecycle are shared through the repository's
existing state root. Hook queues and active hook coordination are checkout-local.
Direct running executions use their existing ownership evidence. A query must
not call the current hook queue enumerator, which removes orphan result files,
or the findings-summary fallback, which logs and hides read errors. Malformed
runtime state is an error, not an empty queue. Stale owners are reported without
being removed or rewritten.

Read a byte-stable copy of the database and WAL into a private temporary directory,
query that copy, and remove it. SQLite readers can create sidecars even with
read-only mode; no SQLite connection opens the repository database. Compare Git,
policy, and hook-queue inputs around the query and return an error if they change.
The proof describes the captured database snapshot, not future mutations. Reading must not recreate deleted state,
upgrade a schema, prune executions, expire duplicate suggestions, or create logs.

## Acceptance evidence

Confirmed test boundaries: the shared readiness service using
real disposable Git/SQLite state, and the freshly built CLI's JSON, exit codes,
and before/after file/database state. Production review persistence is exercised
through its existing application boundary; pure private helpers are not test APIs.

Cover every matrix row, deterministic repeat reads, linked worktrees, moved bases,
rebases, compatible repair chains with a missing middle commit, policy changes,
fixed/dismissed/deferred/regressed/informational findings, untracked findings,
live and stale runtime ownership, malformed runtime files, and read-only failures.
Migration evidence must preserve review/finding IDs, lifecycle history, and
fingerprints. A current query must never require provider credentials.

## Exclusions

No MCP, forge publishing, watcher, automatic review/disposition, independent
checker requirement, requirements-completeness claim, or hosted CI policy is
part of version 1. Requirements and checker evidence remain policy-neutral until
their own contracts ship. The separate telemetry-persistence failure encountered
while reviewing #179 needs a reproduced repair; it is not folded into this
readiness contract.

## Implemented persistence

Schema 8 adds `review_coverage` beside existing operation identities. It records
a policy hash, whether context was pinned to the reviewed commit while the
checkout stayed clean at that same commit before and after execution without
blocking context degradation, and the untracked actionable-output count. Publication inserts this evidence transactionally with
the report locator. Older successful reviews have no retroactively invented
coverage evidence. Staged and skipped reviews establish no committed coverage.
To fill a historical repair gap, review from a clean checkout of that exact
commit, for example a detached linked worktree. Pre-collected context is pinned
to the requested commit, but supplemental provider file tools read the checkout;
a review launched from a different revision cannot establish verified coverage.
Recorded blocking degradations prevent the review from establishing complete
coverage. Readiness reports the review identity and captured blocking degradation
codes/counts in its diagnostic; an older incompatible review must not mask this
current-policy input failure. Repair the input problem before retrying the review. Intentional include/exclude policy
still defines the review scope; omitted findings never count as dispositions.

The command reads local state only. Active execution ownership is checked using
the existing local process lease; no model runtime or external provider is called.
