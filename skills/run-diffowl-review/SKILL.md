---
name: run-diffowl-review
description: Run DiffOwl reviews of the current checkout or a named pull request. Delegate the blocking CLI review to an internal runner and return its completed evidence.
---

# Run DiffOwl Review

Keep the parent available while an internal runner waits for DiffOwl. DiffOwl remains the source of findings.

## 1. Fix the target

Inspect the current branch, `HEAD`, `git status --short`, relevant PR metadata, and `git worktree list --porcelain` before choosing a workspace.

- **Named PR:** read its number, head OID, base OID, and base branch. Select the current or an existing worktree only when its `HEAD` equals the PR head OID. If none matches, create a detached worktree under a run-owned directory from `mktemp -d`. Fetch only a missing PR head or base object, verify both OIDs, and record the canonical temporary parent and worktree paths. Run `diffowl review --base <base-oid> --format json` in the selected worktree.
- **Current branch:** use its PR base OID when available: `diffowl review --base <base-ref> --format json`; otherwise use `diffowl review --base --format json`.

Preserve every existing worktree, branch, and dirty state. Limit Git changes to the run-owned temporary worktree and fetches needed to materialize its verified OIDs. This step is complete only with one exact command, a workspace at the verified target, and its ownership recorded as existing or run-owned temporary.

## 2. Delegate one runner

Create one internal runner subagent, never a user-owned task. Honor an explicit runner model or reasoning request; otherwise select by host:

- **ChatGPT/Codex:** `gpt-5.6-terra` with `low` reasoning.
- **Cursor:** `Composer 2.5`.
- **Claude:** `Sonnet 5` with `low` reasoning.

If the selected model is unavailable, use the least-cost callable runner with low reasoning and disclose the substitution.

The runner model only executes and observes. Pass DiffOwl `--model` or `--reasoning` only for an explicit request to change the DiffOwl/OpenCode review model or reasoning. If no subagent is available, run the command in the foreground and say that the parent cannot remain available.

This step is complete when the runner has the exact workspace, command, ownership record, and scope below.

## 3. Run to completion

The runner executes only the agreed command in the selected workspace and waits through the DiffOwl/OpenCode spinner until the command exits. Its scope is execution and observation: preserve code, findings, existing worktrees, branches, and GitHub state. Use delegation rather than a shell-detached process; `--hook` serves post-commit queues, not detached branch reviews.

Treat cleanup as `finally`, including failure or interruption. For a run-owned worktree, verify its canonical path is beneath the recorded temporary parent and appears in `git worktree list`, then run `git worktree remove --force <worktree-path>` and remove the parent only when empty. If worktree creation never completed, remove only empty run-owned directories. Leave reused worktrees untouched.

Return: exit status, exact command, cwd, workspace ownership, JSON stdout, stderr or failure details, CLI-reported artifact path, and cleanup status. Return an artifact path rather than its contents unless requested. When OpenCode is unavailable, return the observed error promptly. This step is complete only when the command has exited or failed to launch, every evidence field is present, and temporary cleanup is confirmed.

## 4. Report the result

Report completion or failure, target/base, artifact path, and concise JSON findings. Preserve supplied `fnd_*` IDs and lifecycle states; use DiffOwl's `new`, `existing`, and `regressed` states for follow-up reviews. The report is complete when it distinguishes DiffOwl's result from the parent's assessment.
