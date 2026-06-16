---
name: diffowl-resolve
description: Investigates and resolves DiffOwl findings. For 0.3+ durable findings, records lifecycle state via diffowl findings CLI only—markdown reports stay immutable. For legacy pre-0.3 reports, records dispositions in the report and archives when complete. Use when the user asks to resolve, address, investigate, dismiss, clear, or finish findings in `.diffowl/reviews/`.
---

# Resolve DiffOwl Reviews

Treat DiffOwl findings as candidates, not facts. Verify each finding against the current code before changing anything.

## Prerequisite

Run this skill from a repository where DiffOwl has produced `.diffowl/reviews/latest.md` or durable findings are available through `diffowl findings`. If neither exists, explain that the user must first run `diffowl review` or install the post-commit hook with `diffowl hook install`; do not create an empty resolution report.

## Two Workflows

| Report type | How to tell | Resolution state | Edit markdown? |
| ----------- | ----------- | ---------------- | -------------- |
| **Durable (0.3+)** | Frontmatter has `schema_version` and/or headings include `` `fnd_*` `` IDs | `diffowl findings *` → SQLite | **Never** |
| **Legacy (pre-0.3)** | No `schema_version`, no `fnd_*` IDs in headings | `## Resolution` checklist in the timestamped report | Append/merge `## Resolution` only |

Markdown reports from 0.3+ are **immutable snapshots**. Lifecycle commands update SQLite only. Do not append, merge, or rewrite durable report bodies—even for a human-readable checklist.

## Scope

Resolve only the scope the user requested:

- **latest** or no qualifier: the canonical timestamped report matching `latest.md`.
- **latest N**: the `N` newest unresolved canonical reports, newest first.
- **all**: every unresolved canonical report under `.diffowl/reviews/`.
- **filename or path**: only that report.
- **finding N**: only that finding within the selected report.

Never infer a wider scope.

For **legacy** reports, do not reprocess reports under `.diffowl/reviews/resolved/` unless the user names one or it contains an unchecked **Open** or **Deferred** disposition.

For **durable** findings, use `diffowl findings` as the unresolved backlog. A finding does not auto-resolve because a later review omitted it.

## Shared Investigation Steps

1. Read repository instructions and determine the exact scope above.
2. Run `diffowl findings`. If unresolved durable findings exist, follow the **Durable Findings Workflow** below and do not edit markdown reports.
3. Otherwise follow the **Legacy Report Workflow** below.
4. Resolve `latest.md` to its canonical `review-*.md` by matching `diffowl.session_id`; if unavailable, match the generated review body. Never edit or archive `latest.md`.
5. Process only entries under `### Issues Found`. Diagnostics and suppressed candidates are not findings unless the user explicitly asks to investigate them.
6. Investigate each finding against the current worktree, surrounding code, tests, and relevant history.
7. Classify each finding:
   - **Fixed**: changed code or configuration to address a confirmed issue.
   - **Already fixed**: the current worktree no longer exhibits the issue.
   - **Agent dismissed**: investigation showed the finding was noise or based on an incorrect assumption.
   - **User dismissed**: the user explicitly chose not to address the finding.
   - **Deferred**: valid but intentionally left unresolved.
   - **Open**: not yet investigated.
8. Fix confirmed findings using the repository's normal workflow and run verification appropriate to the changed surface.
9. Commit code fixes when the repository workflow expects commits and permissions allow it. Commit hashes belong in resolution notes only after the commits exist.

Post-commit hooks may replace `latest.md` while resolving. Continue with the scope selected at the start; do not switch to a new latest report.

## Durable Findings Workflow (0.3+)

SQLite is the source of truth. Markdown is read-only context.

1. Run `diffowl findings` before resolving to capture the current unresolved backlog.
2. Use durable `fnd_*` IDs from the backlog or report headings for lifecycle commands. Use `latest:N` only when a durable ID is not practical.
3. Inspect details as needed with `diffowl findings show <locator> --format json`.
4. For a confirmed fix, run verification first, then record:

```bash
diffowl findings fix <locator> --note <text> --verified-by <command> --commit <ref> --actor agent
```

5. For a false positive:

```bash
diffowl findings dismiss <locator> --reason <text> --actor agent
```

6. For intentional deferral:

```bash
diffowl findings defer <locator> --reason <text> --actor agent
```

7. Rerun `diffowl findings` and confirm resolved items no longer appear in the unresolved backlog.

Do not mark a durable finding fixed unless at least one relevant verification command completed successfully. Include `--commit` only after the commit exists.

**Do not** modify timestamped markdown reports, append `## Resolution`, or archive reports as a proxy for durable lifecycle state. Report archive/cleanup policy for durable reviews is deferred to a later release.

## Legacy Report Workflow (pre-0.3)

Use when `diffowl findings` is unavailable or returns no durable backlog for the scope.

1. For `latest N`, sort unresolved timestamped reports by filename timestamp and select the newest `N`.
2. Use the explicit `Finding N` heading as its stable ID. For older reports without headings, assign IDs by report order.
3. Preserve the generated review body. Merge dispositions into the existing `## Resolution` section or append exactly one section if absent; do not duplicate entries.
4. Archive the canonical report under `.diffowl/reviews/resolved/` only when every finding in that report has a checked disposition.

### Legacy Resolution Format

Use one item per finding, preserving the report's explicit `Finding N` IDs:

```md
## Resolution

- [x] Finding 1 - **Fixed**
  - Commit: `abc1234`
  - Note: Added validation for the external payload.
  - Verified: `pnpm run test`, `pnpm run lint`

- [x] Finding 2 - **Agent dismissed**
  - Note: The reported path is guarded by the caller.

- [ ] Finding 3 - **Deferred**
  - Note: Requires an upstream dependency change.
```

Checked statuses are **Fixed**, **Already fixed**, **Agent dismissed**, and **User dismissed**. Unchecked statuses are **Deferred** and **Open**.

## Rules

- Never mark a finding fixed without verifying the relevant behavior.
- Never mark a durable finding fixed without `diffowl findings fix` and `--verified-by`.
- Never modify a 0.3+ markdown report file.
- Never use **User dismissed** unless the user explicitly made that decision.
- Include a concise reason for every dismissal or deferral.
- Include commit hashes only after those commits exist.
- Do not claim a verification command passed unless it was run successfully.
- After durable lifecycle mutations, rerun `diffowl findings` and confirm resolved items no longer appear in the unresolved backlog.
- For legacy reports only: do not archive a report containing deferred or open findings.
- Archiving is not deletion. Never delete or prune review history unless the user explicitly requests deletion.
- `.diffowl` artifacts are workflow records, not code changes. Do not commit them unless the repository tracks them or the user explicitly asks.
- Do not create sidecar resolution files or temporary tracking scripts.
