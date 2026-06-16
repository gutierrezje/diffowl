---
name: diffowl-resolve
description: Investigates and resolves findings from DiffOwl review reports, records explicit dispositions in the original report, and archives fully handled reviews. Use when the user asks to resolve, address, investigate, dismiss, clear, or finish findings in `.diffowl/reviews/`.
---

# Resolve DiffOwl Reviews

Treat DiffOwl findings as candidates, not facts. Verify each finding against the current code before changing anything.

## Prerequisite

Run this skill from a repository where DiffOwl has produced `.diffowl/reviews/latest.md` or durable findings are available through `diffowl findings`. If neither exists, explain that the user must first run `diffowl review` or install the post-commit hook with `diffowl hook install`; do not create an empty resolution report.

## Scope

Resolve only the scope the user requested:

- **latest** or no qualifier: the canonical timestamped report matching `latest.md`.
- **latest N**: the `N` newest unresolved canonical reports, newest first.
- **all**: every unresolved canonical report under `.diffowl/reviews/`.
- **filename or path**: only that report.
- **finding N**: only that finding within the selected report.

Never infer a wider scope. Do not reprocess reports under `.diffowl/reviews/resolved/` unless the user names one or it contains an unchecked **Open** or **Deferred** disposition.

## Workflow

1. Read repository instructions and determine the exact scope above.
2. Check whether durable findings are available by running `diffowl findings`. If unresolved durable findings exist, use the durable findings workflow below as the source of truth for lifecycle status.
3. Resolve `latest.md` to its canonical `review-*.md` by matching its `diffowl.session_id`; if unavailable, match the generated review body. Never edit or archive `latest.md`.
4. For `latest N`, sort unresolved timestamped reports by filename timestamp and select the newest `N`.
5. Process only entries under `### Issues Found`. Diagnostics and suppressed candidates are not findings unless the user explicitly asks to investigate them.
6. Parse each finding and investigate it against the current worktree, surrounding code, tests, and relevant history. Prefer durable `fnd_*` IDs from report headings or `diffowl findings`; otherwise use the explicit `Finding N` heading as its stable ID. For older reports without headings or IDs, assign IDs by report order.
7. Classify each finding:
   - **Fixed**: changed code or configuration to address a confirmed issue.
   - **Already fixed**: the current worktree no longer exhibits the issue.
   - **Agent dismissed**: investigation showed the finding was noise or based on an incorrect assumption.
   - **User dismissed**: the user explicitly chose not to address the finding.
   - **Deferred**: valid but intentionally left unresolved.
   - **Open**: not yet investigated.
8. Fix confirmed findings using the repository's normal workflow and run verification appropriate to the changed surface.
9. Commit code fixes when the repository workflow expects commits and permissions allow it. Use the repository's commit conventions. Commit hashes belong in resolutions only after the commits exist.
10. For durable findings, record lifecycle status with `diffowl findings fix`, `diffowl findings dismiss`, or `diffowl findings defer`. Markdown archival alone is not sufficient when durable findings exist.
11. Preserve the generated review body. Merge dispositions into the existing `## Resolution` section or append exactly one section if absent; do not duplicate entries.
12. Archive the canonical report under `.diffowl/reviews/resolved/` only when every finding in that report has a checked disposition.

Post-commit hooks may replace `latest.md` while resolving a report. Continue updating the canonical timestamped report selected at the start; do not switch scope to the new latest report.

## Durable Findings Workflow

Use this path when `diffowl findings` exists and returns unresolved durable findings. The SQLite lifecycle is the source of truth for current finding state; Markdown reports are historical snapshots.

1. Run `diffowl findings` before resolving to capture the current unresolved backlog.
2. Use durable finding IDs from the backlog for lifecycle commands. Use `latest:N` only for findings from the latest review when a durable ID is not practical.
3. Inspect details as needed with `diffowl findings show <locator> --format json`.
4. For a confirmed fixed finding, first run the verification command(s), then record the fix:

```bash
diffowl findings fix <locator> --note <text> --verified-by <command> --commit <ref> --actor agent
```

5. For a false positive or incorrect finding, record an agent dismissal:

```bash
diffowl findings dismiss <locator> --reason <text> --actor agent
```

6. For a valid finding intentionally left unresolved, record a deferral:

```bash
diffowl findings defer <locator> --reason <text> --actor agent
```

7. Rerun `diffowl findings` after resolving and confirm fixed, dismissed, or deferred items no longer appear in the unresolved backlog.

Do not mark a durable finding fixed unless at least one relevant verification command completed successfully. Include `--commit` only after the commit exists. If no commit was created, omit `--commit` and explain why in the note.

## Resolution Format

For **legacy reports** without durable findings, use one item per finding, preserving the report's explicit `Finding N` IDs. For older reports without explicit IDs, number findings by report order.

For **0.3+ reports** with `fnd_*` IDs in headings, prefer `diffowl findings *` lifecycle commands. You may still append a `## Resolution` checklist for human readability, but SQLite lifecycle records are authoritative when durable findings exist.

Legacy checklist example:

```md
## Resolution

- [x] Finding 1 - **Fixed**
  - Commit: `abc1234`
  - Note: Added validation for the external payload.
  - Verified: `pnpm run test`, `pnpm run lint`

- [x] Finding 2 - **Agent dismissed**
  - Note: The reported path is guarded by the caller.

- [x] Finding 3 - **Already fixed**
  - Commit: `def5678`
  - Note: The current worktree includes the correction from an earlier change.

- [x] Finding 4 - **User dismissed**
  - Note: User accepted the current behavior.

- [ ] Finding 5 - **Deferred**
  - Note: Requires an upstream dependency change.
```

Checked statuses are **Fixed**, **Already fixed**, **Agent dismissed**, and **User dismissed**. Unchecked statuses are **Deferred** and **Open**.

## Rules

- Never mark a finding fixed without verifying the relevant behavior.
- Never mark a durable finding fixed without recording it through `diffowl findings fix`.
- Never use **User dismissed** unless the user explicitly made that decision.
- Include a concise reason for every dismissal or deferral.
- Include commit hashes only after those commits exist.
- Do not claim a verification command passed unless it was run successfully.
- After durable lifecycle mutations, rerun `diffowl findings` and confirm resolved items no longer appear in the unresolved backlog.
- Do not archive a report containing deferred or open findings.
- Archiving is not deletion. Never delete or prune review history unless the user explicitly requests deletion.
- `.diffowl` artifacts are workflow records, not code changes. Do not commit them unless the repository tracks them or the user explicitly asks.
- Do not create sidecar resolution files or temporary tracking scripts.
