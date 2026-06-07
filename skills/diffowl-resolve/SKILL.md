---
name: diffowl-resolve
description: Investigates and resolves findings from DiffOwl review reports, records explicit dispositions in the original report, and archives fully handled reviews. Use when the user asks to resolve, address, investigate, dismiss, clear, or finish findings in `.diffowl/reviews/`.
---

# Resolve DiffOwl Reviews

Treat DiffOwl findings as candidates, not facts. Verify each finding against the current code before changing anything.

## Workflow

1. Read repository instructions, then inspect `.diffowl/reviews/latest.md` unless the user names another report.
2. If `latest.md` points to or duplicates a timestamped report, update the timestamped report as the canonical record.
3. Parse every finding and investigate it against the current worktree, surrounding code, tests, and relevant history.
4. Classify each finding:
   - **Fixed**: changed code or configuration to address a confirmed issue.
   - **Already fixed**: the current worktree no longer exhibits the issue.
   - **Agent dismissed**: investigation showed the finding was noise or based on an incorrect assumption.
   - **User dismissed**: the user explicitly chose not to address the finding.
   - **Deferred**: valid but intentionally left unresolved.
   - **Open**: not yet investigated.
5. Fix confirmed findings using the repository's normal development workflow. Follow required testing, formatting, and commit conventions.
6. Run verification appropriate to the changed surface.
7. Preserve the generated review body. Append or update only one `## Resolution` section.
8. Archive the canonical report under `.diffowl/reviews/resolved/` only when every finding is checked.

## Resolution Format

Use one item per finding, in report order:

```md
## Resolution

- [x] Finding 1 - **Fixed**
  - Commit: `abc1234`
  - Note: Added validation for the external payload.
  - Verified: `pnpm run test`, `pnpm run lint`

- [x] Finding 2 - **Agent dismissed**
  - Note: The reported path is guarded by the caller.

- [x] Finding 3 - **User dismissed**
  - Note: User accepted the current behavior.

- [ ] Finding 4 - **Deferred**
  - Note: Requires an upstream dependency change.
```

Checked statuses are **Fixed**, **Already fixed**, **Agent dismissed**, and **User dismissed**. Unchecked statuses are **Deferred** and **Open**.

## Rules

- Never mark a finding fixed without verifying the relevant behavior.
- Never use **User dismissed** unless the user explicitly made that decision.
- Include a concise reason for every dismissal or deferral.
- Include commit hashes only after those commits exist.
- Do not claim a verification command passed unless it was run successfully.
- Do not archive a report containing deferred or open findings.
- Do not delete review history unless the user explicitly requests deletion.
- Do not create sidecar resolution files or temporary tracking scripts.
