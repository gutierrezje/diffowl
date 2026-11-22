# AI code review products: latency and review-loop research

Research checked August 31, 2026. Sources are vendor documentation and vendor-maintained product pages. Vendor quality claims are treated as claims, not benchmarks.

## Evidence target

This research tests two questions:

1. Is DiffOwl's timeout problem simply an unusually slow reviewer?
2. Which documented product mechanisms make AI review usable when duration varies from seconds to tens of minutes?

The answer to the first question is no. The category contains several distinct service levels. The useful lesson is not one correct timeout. It is to make review depth, expected wait, progress, repeated-change coverage, and completion state explicit.

## What the market actually documents

| Product                    | Published wait                                                                                                                              | Depth and execution contract                                                                                                                                                     | Repeated changes                                                                                                                                 | Local workflow                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot code review | A requested review usually takes **less than 30 seconds**.                                                                                  | `Lite` is the fast, targeted default. `Balanced` uses a higher-reasoning model for longer analysis and costs more.                                                               | Automatic review on every push is optional. GitHub warns this can create noise, and a re-review can repeat resolved or downvoted comments.       | Review is available on GitHub and in supported IDEs. [Usage](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review?tool=vscode) [Effort levels](https://docs.github.com/en/copilot/concepts/agents/code-review)                                                                                                                     |
| Greptile                   | PRs: **about 1-2 minutes small, 3 minutes medium, 3-5 minutes large**. Its CLI landing page advertises a branch review in **60 seconds**.   | Full-codebase graph context. The CLI gives reviews durable IDs, can resume unfinished work, reopen a result, and report running, failed, cancelled, or completed status.         | Update-triggered PR reviews are documented as fresh, independent passes. Incremental coverage or finding deduplication is not documented.        | A current CLI reviews local committed branch changes and supports agent-oriented output. [PR timing](https://www.greptile.com/docs/code-review/developer-essentials) [CLI](https://www.greptile.com/docs/code-review/greptile-cli) [CLI target](https://www.greptile.com/cli) [Update behavior](https://www.greptile.com/docs/code-review-bot/trigger-code-review)                |
| CodeRabbit                 | CLI reviews can take **7-30+ minutes**, depending on scope.                                                                                 | The CLI offers a lighter review policy and tells coding agents to run long reviews in the background and check periodically. PR reviews expose in-progress and completion state. | PR reviews are incremental by default. After five reviewed commits, automatic review pauses by default to avoid near-duplicate review storms.    | CLI modes cover committed, uncommitted, or combined changes and provide structured agent output. [CLI duration](https://docs.coderabbit.ai/cli/index) [CLI reference](https://docs.coderabbit.ai/cli/reference) [Incremental controls](https://docs.coderabbit.ai/configuration/auto-review) [PR state](https://docs.coderabbit.ai/pr-reviews/walkthroughs)                       |
| Cursor Bugbot              | No absolute time target found in the reviewed docs.                                                                                         | `Default`, `High`, and rule-driven `Custom` effort levels trade speed, cost, and depth. Its API queues work asynchronously and returns a request ID for later lookup.            | Incremental review covers only changes since the prior review. A run-once option skips later updates.                                            | `/review-bugbot` reviews a local branch. Cursor stores the patch ID, then skips the remote PR review when the PR contains the same diff. [Bugbot](https://prod.cursor.com/docs/bugbot)                                                                                                                                                                                            |
| Qodo v2                    | No absolute time target found in the reviewed docs.                                                                                         | Multi-agent review uses repository context, PR history, requirements, and organization rules.                                                                                    | Current documentation does not establish commit-level incremental coverage.                                                                      | The IDE reviews uncommitted changes or the final branch diff across several commits, and can send findings to CLI coding agents for repair. [PR review](https://docs.qodo.ai/code-review) [Committed review](https://docs.qodo.ai/qodo-ide/code-review/review-committed-changes) [Changelog](https://docs.qodo.ai/changelog)                                                      |
| Bito                       | No absolute time target found in the reviewed docs.                                                                                         | `Essential` and `Comprehensive` modes trade speed for depth. Its PR reviewer mixes repository context with deterministic analysis and security tools.                            | Incremental review analyzes only recent changes. A configurable batch time delays work for 0 minutes to 24 hours so rapid pushes can be grouped. | IDE and CLI review committed or uncommitted changes. [Modes](https://docs.bito.ai/try-bitos-ai-code-review) [Incremental review](https://docs.bito.ai/ai-code-reviews-in-git/key-features) [Batching](https://docs.bito.ai/ai-code-review-agent/install-run-using-bito-cloud/create-or-customize-an-agent-instance) [CLI](https://docs.bito.ai/ai-code-reviews-in-cli/how-to-use) |
| Ellipsis                   | No absolute time target. Its docs say parallel reviewers do not add latency, while an optional gatekeeper roughly doubles latency and cost. | A configurable pipeline can run up to eight reviewers, deduplicate findings, gate them, and stop at explicit per-run, daily, or weekly budgets.                                  | Each push reviews only unreviewed commits. Budget exhaustion records incomplete coverage so a later run can cover the missed commits.            | PR-centered. [Incremental review](https://www.ellipsis.dev/docs/code-review/guides/how-to-review-every-pull-request-as-commits-land) [Pipeline and budgets](https://www.ellipsis.dev/docs/code-review/configuration-yaml)                                                                                                                                                         |

Graphite Agent was also checked. It exposes `Running`, `Completed`, and `Not running` states, whole-repository context, configurable rules, feedback analytics, and a 200,000-character PR cutoff, but no public duration target was found. [Graphite review](https://graphite.com/docs/ai-reviews) [Review state](https://graphite.com/docs/ai-review-comments)

## The recurring product mechanisms

### 1. Speed is a named service level

GitHub, Cursor, and Bito do not make one review configuration serve every purpose. They expose an effort or depth choice. Published expectations then range from GitHub's sub-30-second review to CodeRabbit's 7-30+ minute deep CLI workflow. Calling both of these simply "review" hides the most important user-facing difference.

### 2. Long reviews are durable jobs

The better contract is `queued -> running -> completed | failed | cancelled | superseded`, with a stable ID and a way to reattach. Greptile's CLI makes this explicit. Cursor's API also returns after queueing and exposes the request ID. CodeRabbit tells agents to background the work. These products do not depend on a foreground command surviving for the entire review.

### 3. New pushes do not blindly create equivalent work

CodeRabbit pauses automatic review storms. Bito batches pushes. CodeRabbit, Bito, Cursor, and Ellipsis review only new changes. Cursor additionally deduplicates a local review against the later PR by patch identity. These are different policies, but they share a principle: content identity matters more than the event that happened to trigger a review.

### 4. Coverage is explicit

Incremental review creates a second product question: what has actually been reviewed? Ellipsis is the clearest documentation here. It records uncovered commits when a budget interrupts a run. A generic success flag is weaker than an answer to "which exact change content is covered, and what remains?"

### 5. Feedback becomes scoped policy

CodeRabbit, Greptile, Cursor, Qodo, Bito, and Graphite all document some form of rules, learned preferences, or feedback-driven noise reduction. DiffOwl already records stronger raw signals than a thumbs-up because findings can be fixed, dismissed, deferred, reopened, and verified. The safe pattern is to propose scoped rules from repeated dispositions and require approval before enforcing them.

## DiffOwl's current behavior

The repository already has several useful foundations:

- The post-commit hook is non-blocking.
- Each review operation records immutable input identity, including the diff hash, context depth, and a context manifest (`src/review/operation.ts`).
- Executions persist backend, model, reasoning, and terminal outcome (`src/state/repositories/review-executions.ts`).
- Findings have a durable lifecycle rather than disappearing with one report.

The latency contract is much weaker:

- One global `timeout` defaults to 300 seconds (`src/config.ts`). The current repository configuration has already raised it to 900 seconds.
- The OpenCode settlement coordinator treats that value as a total wall-clock deadline. Periodic reconciliation can recover a completed response, but activity does not extend the deadline (`src/opencode/settlement.ts`). This distinguishes neither a healthy slow review from a stalled review nor a foreground target from a background ceiling.
- `shallow` removes related-file and reference context, but it keeps the same reviewer assignment and reasoning choice (`src/review/context.ts`). It is a context switch, not a complete speed/depth profile.
- The hook worker processes each queued commit serially as its own `review --commit` invocation (`src/git/hooks.ts`). Pending commits are not coalesced or superseded when a newer commit contains the final branch state.
- Completed reports are durable, but an interrupted review is not a user-resumable job with a first-class status surface.

### Observed local timing

The current `.diffowl/state.db` contains 478 completed executions with a recorded `review-run` timing. This is historical local data, not a controlled benchmark.

| Backend cohort               | Completed |    p50 |    p90 |    p95 | Maximum |
| ---------------------------- | --------: | -----: | -----: | -----: | ------: |
| Legacy, backend not recorded |       362 |  87.0s | 274.3s | 326.8s |  884.1s |
| OpenCode                     |       101 | 102.3s | 256.2s | 281.2s |  701.2s |
| Codex                        |        15 | 146.5s | 581.5s | 767.8s |  767.8s |

The Codex sample exposes why a universal timeout is misleading. Five completed `gpt-5.6-sol` runs at automatic reasoning averaged 29.6 seconds, while ten completed `gpt-5.6-luna` runs at maximum reasoning averaged 296.1 seconds and reached 767.8 seconds. The current execution table also records one Codex timeout, two Codex failures, and one OpenCode failure. Older legacy rows do not preserve terminal failures in the same schema, so this is not a lifetime failure-rate estimate.

## Product direction for DiffOwl

### Priority 0: make review profiles real contracts

Replace the current `depth + timeout` mental model with three user-facing profiles:

| Profile  | User promise                                                             | Suggested behavior                                                                                                  |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Quick    | Feedback while the author is still in the loop. Target under 60 seconds. | Fast configured model and reasoning, shallow bounded context, foreground progress, explicit incomplete-depth label. |
| Standard | Normal pre-commit or commit review. Target under 5 minutes.              | Default context, normal reasoning, foreground or background at the caller's choice.                                 |
| Deep     | Thorough review where waiting is not interactive.                        | High reasoning, full available context, durable background job, reattach/status, no short wall-clock cutoff.        |

These targets are product goals inferred from the published category split, not guarantees already supported by every backend. Because user-chosen models are part of DiffOwl's value, profiles should store or recommend a backend/model/reasoning assignment instead of silently replacing the user's model.

### Priority 1: separate a stall timeout from a completion deadline

Keep a short timeout for no progress, broken transport, or a dead provider. Make the total completion deadline optional and profile-specific. Persist `queued`, `running`, `completed`, `failed`, `cancelled`, and `superseded` state. Let a later command reattach to the operation or inspect its final result.

Raising 300 seconds to a larger universal number would reduce some failures, but it would preserve the underlying ambiguity and make genuine stalls slower to detect.

### Priority 2: deduplicate and coalesce by review content

Use the existing diff hash and operation identity as the foundation for two policies:

1. If staged, committed, hook, or later PR review represents the same normalized change content under the same review profile, reuse the existing coverage instead of reviewing again. Cursor's patch-ID bridge is the strongest documented example.
2. When several commits queue faster than the reviewer completes, replace untouched pending snapshots with one latest uncovered range or final branch-state operation. Preserve the coverage ledger so the system can still say exactly which change content was analyzed.

Do not cancel a healthy active review by default. Mark newer work as pending or superseding, then decide at the operation boundary. This avoids throwing away a nearly complete expensive run.

### Priority 3: turn dispositions into proposed rules

Aggregate repeated dismissals, fixes, deferrals, and verification outcomes by repository path and issue type. Suggest a plain-language scoped rule only when the evidence repeats. Show examples and require approval. This borrows the useful learning loop without making hidden model memory the source of truth.

## What not to copy yet

- A hosted PR dashboard, review diagrams, or a large catalog of bundled linters would expand the product sideways before the core local loop is reliable.
- Automatic model switching without an explicit profile would weaken DiffOwl's provider-neutral promise.
- A second full review after every repair would discard DiffOwl's strongest differentiator: exact cumulative coverage over durable operations.
- A larger fixed timeout alone would treat the symptom, not define when a review is quick, deep, stalled, or safely running in the background.

## Positioning

The defensible position is not "another AI PR reviewer." It is a local, provider-neutral review control plane for agent-written changes: exact change identity, user-selected reviewers, durable findings, explicit coverage, and a review job that remains trustworthy across commits and retries.

The immediate competitive gap is therefore review orchestration, not review-comment presentation. DiffOwl already has the data model needed to close much of it.

## Confidence and limits

Confidence is high on documented workflow behavior and on the local timing query. Confidence is medium on proposed profile targets because published vendor numbers are not independent benchmarks and change size is not normalized. No comparable recall, precision, or false-positive dataset was found in the reviewed vendor documentation. Qodo's current v2 behavior should not be inferred from legacy Qodo Merge v1 settings.
