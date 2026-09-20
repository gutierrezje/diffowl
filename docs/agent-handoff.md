# Agent handoff

Before declaring completion, handing work to another agent, or opening a pull
request, obtain a current `diffowl readiness --format json` result from the
implementation checkout. The [readiness contract](readiness-contract.md) owns
the policy; every client follows the returned `next_action`. Tests, provider
success, a quiet findings summary, and saved Markdown are not readiness proofs.

## Query and act

1. Select the intended base ref. Run
   `diffowl readiness --base <base-ref> --format json`; omit `--base` only when the
   locally detected default branch is intended. Retain stdout and the process
   exit status even when nonzero. Keep using the base ref on subsequent queries
   so a moved base is detected. If reviews use an explicit `--depth`, pass that
   same depth to readiness.
2. Accept schema version 1. Exit 0/result `ready` allows `handoff`; exit 1/result
   `not-ready` requires the returned action; exit 2/result `error` reports a read
   failure. A failed launch, malformed JSON, unknown version/action, or
   inconsistent process exit and JSON is an operational blocker. Preserve its
   diagnostic; never translate it to a missing review or a ready result.
3. Follow exactly one action below, within the task's authority, then re-query.
   The query is read-only. Reviews, waits, and lifecycle mutations are separate,
   explicit workflow actions. Re-query just before starting a review so a hook
   or another agent's running work is consumed instead of duplicated. Avoid
   concurrent review owners for the same scope.
4. Re-query after changes to code, base/HEAD, review policy, review execution or
   publication, and finding state. Finish only with a fresh proof immediately
   before handoff or an explicit blocker identifying the missing action or
   authority. Elapsed time never turns pending or failed work into ready.

| `next_action` | Workflow action |
| --- | --- |
| `wait` | Wait on the existing runner or hook queue, then re-query. Do not start another review. If the runner cannot be observed or never settles, report pending work as the blocker. |
| `review-branch` | Inspect any input-coverage diagnostic first; fix the collection problem before retrying, and report a blocker if it cannot be repaired. Do not repeat an unchanged review that cannot establish coverage. Confirm the checkout is clean and HEAD still equals `target.head_commit`. Run one `diffowl review --base <target.base_commit>` with the expected policy/depth. This supplies the missing complete branch checkpoint, including after a moved base or rewritten history. |
| `review-uncovered-change` | Preserve the checkpoint and repair IDs. Review only `coverage.uncovered_commits`, in order, using `diffowl review --commit <sha>` from a clean checkout at each exact SHA. Use a disposable detached linked worktree for historical gaps, preserving the handoff checkout. Re-query in the original handoff checkout between reviews; do not repeat covered commits. |
| `disposition-findings` | Inspect the durable candidates and record each decision through the lifecycle below. Re-query after every mutation. |
| `commit-or-restore` | Commit the coherent verified changes when authorized, or restore only explicitly disposable/authorized edits. Preserve unrelated work. If neither action is authorized, report the dirty checkout as blocked. |
| `inspect-failure` | Inspect the failed execution/runner output or `diffowl hook status --format json` for a hook failure. Repair its cause within scope, re-query, then explicitly retry the failed target if still required. Stop with the failure evidence if it persists; do not retry indefinitely. |
| `repair-dependency` | Report and repair the named Git/config/database/runtime read failure within scope. Schema migration is a separate explicit write; incompatible versions need a compatible CLI. Re-query after repair. |
| `handoff` | Emit the current proof below. |

A latest-commit or staged review cannot substitute for a complete branch
checkpoint. Readiness decides whether existing checkpoint plus repair coverage
is sufficient; clients do not implement their own freshness or coverage policy.
Keep the handoff checkout until the final query even if a review runner cleans
up its own temporary worktree.

## Finding dispositions

Use `diffowl findings list --format json` and
`diffowl findings show <fnd_id> --format json` to inspect candidates, observations,
and lifecycle events. The list exposes open/regressed findings, not deferred
ones. If `blockers.deferred` is nonzero, retain IDs from prior lifecycle receipts
and inspect them with `show` when available. If IDs are unavailable, report the
returned deferred count and the discovery limitation as an explicit blocker;
an empty list is not evidence of readiness. The current lifecycle cannot reopen
deferred findings, so this path requires a lifecycle capability change rather
than another review or automatic dismissal. Select relevant findings for the
target branch; the backlog can also contain unrelated work. Correlate known
finding IDs with the exact review/finding receipts available for this task.
Readiness returns counts, and the finding detail does not expose review target
OIDs. If those receipts cannot establish a candidate's relevance, report the
scope-discovery gap as a blocker instead of mutating an unrelated finding or
reading SQLite to reconstruct scope. Record decisions with durable IDs:

```sh
diffowl findings fix <fnd_id> --note '<fix evidence>' --verified-by '<passed check>' --actor agent
diffowl findings dismiss <fnd_id> --reason '<reproducible non-bug evidence>' --actor agent
diffowl findings defer <fnd_id> --reason '<reason and follow-up>' --actor agent
```

Verify a fix before recording it; add `--commit <sha>` only when that commit
exists. A deferral is auditable but still blocks version 1 readiness. Do not
dismiss a real issue merely to obtain ready, infer resolution from a later
review's omission, or change immutable Markdown reports. For an untracked
blocker there is no lifecycle ID: report that limitation explicitly. Re-running
a review that omits it does not clear it.

## Handoff proof

Attach the final CLI JSON unchanged, preferably as a compact JSON block. It
already contains the machine-verifiable receipt: `schema_version`, exact
`target.base_commit`, `target.merge_base_commit`, `target.head_commit`,
`policy_sha256`, `worktree_clean`, `coverage.checkpoint_review_id`, ordered
`coverage.repair_review_ids`, `coverage.uncovered_commits`, `blockers`, `result`,
`reason`, `next_action`, `exit_code`, and `diagnostic`. Add the total blocker
count (`open + regressed + deferred + untracked`) in the accompanying sentence.
Use full OIDs and durable review IDs, never a mutable `latest.md` alias.

For not-ready or error, attach the actual response and name the unresolved
action/diagnostic. If no valid response exists, include the command, process
failure, and stderr instead; do not fabricate proof fields. Verification results
can still be reported, but the branch is not ready. Any subsequent mutation
invalidates this handoff response and requires a new query. A ready proof is
local review evidence; it does not grant commit, push, or merge authority.

## Client adapters

`diffowl init` can install the common loop in its managed AGENTS.md block. For
existing installations, replace that block with the current instructions when
setup offers it; preserve the surrounding project instructions. The installed
block works without downloading this document.

Each client needs only a pointer to the shared instructions, not its own action
table or readiness calculation:

| Client | Adapter/example |
| --- | --- |
| Codex | Keep the managed block in the project `AGENTS.md`; include its proof in the final response or delegated handoff. |
| Claude Code | In `CLAUDE.md`, add: “Before completion, read and follow the DiffOwl section in AGENTS.md.” Its optional SessionStart findings summary supplies context only. |
| Cursor | In a project rule, add: “Before completion, read and follow the DiffOwl section in AGENTS.md.” |
| Generic agent | Load the DiffOwl section of AGENTS.md into the task instructions and capture both stdout and exit status from the CLI. |

For this repository, [AGENTS.md](../AGENTS.md) points directly to this workflow.
All clients use the same CLI response and lifecycle; no MCP or forge is required.
