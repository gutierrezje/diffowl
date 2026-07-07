# DiffOwl

```text
,___,
(O,O)
/)_)
" "
```

> **The verification layer for agent-written code.**
>
> An independent reviewer that runs locally on every commit — on the model you already use, no matter which agent (or human) wrote the code.

Coding agents now write much of the code, but the agent that wrote a patch shouldn't be its only reviewer. DiffOwl is a separate, independent review pass: it builds bounded local context from your diff and asks a model for structured, durable findings. It works the same whether the change came from Claude Code, Cursor, OpenCode, or your own hands.

Under the hood it drives a headless [OpenCode](https://opencode.ai/docs/server/) session for model execution, so you bring your own provider and pay no one but them — no DiffOwl account, no service in the loop.

---

## Features

- **Agent-Agnostic**: Reviews code from any source — Claude Code, Cursor, OpenCode, or a human. The reviewer stays independent from whoever wrote the patch.
- **Provider-Neutral**: Runs on whatever model and provider you have configured in OpenCode (Copilot, OpenAI, local, and more). No separate keys, no DiffOwl account, no per-seat bill.
- **First-Class TypeScript Support**: Automatically extracts modified TypeScript AST nodes (functions, classes, interfaces, types, enums, methods, properties, and top-level const declarations) to feed rich, structured context to the AI reviewer.
- **Automatic Git Hooks**: Reviews run on every commit and stay out of your way — results land in `.diffowl/` when they are ready.
- **Review Chat Handoff**: Reopen the OpenCode session behind the latest or any selected review with `diffowl chat`.
- **Review Depth Profiles**: Choose `shallow` or `default` context strategies to match fast hooks or normal reviews.
- **Intelligent File Filtering**: Supports `include` and `exclude` glob patterns to focus reviews on source directories while skipping build artifacts, lockfiles, and node modules.
- **Project-Specific Rules**: Inject custom guidelines directly into the reviewer's system prompt (e.g., "Check for SQL injection", "Ensure TypeScript types are explicit").
- **Interactive Model Selector**: Automatically queries OpenCode to present a clean, interactive list of your connected providers and models.
- **Local Reports**: Generates markdown reviews under `.diffowl/reviews/`, including durable finding IDs and hidden session metadata that makes reports chat-capable.
- **Durable Findings (0.3)**: Persists reviews and findings in `.diffowl/state.db` with stable `fnd_*` IDs, occurrence tracking, and lifecycle commands for fix, dismiss, defer, and reopen.
- **Agent-Assisted Resolution**: Includes an optional portable skill that lets coding agents investigate findings, fix confirmed issues, record dismissals, and archive handled reports.
- **Hook Log Retention**: Bounds accumulated hook logs without deleting review history.

---

## Quick Start

### 1. Prerequisites

1. **Verify Node.js 22.14.0 or newer is installed**:
   ```bash
   node --version
   ```
2. **Install OpenCode CLI**:
   ```bash
   npm install --global opencode-ai
   ```
3. **Authenticate a provider and confirm a model is available**:
   ```bash
   opencode
   ```
   In OpenCode, connect or authenticate a provider such as GitHub Copilot, OpenAI, or Ollama. Confirm that at least one model is available before continuing.

### 2. Install DiffOwl

```bash
npm install --global diffowl
```

### 3. Initialize DiffOwl in Your Repository

To set up DiffOwl for your project, navigate to your target git repository and run:

```bash
diffowl init
```

This will:

1. Start an OpenCode server if needed and `server.auto_start` is enabled.
2. Fetch your connected providers and active models.
3. Allow you to select a model interactively.
4. Generate a `.diffowl.yml` configuration file in the current project.

> [!IMPORTANT]
> DiffOwl uses OpenCode's existing provider credentials. It does not configure provider keys itself. If initialization reports no active models, run `opencode`, connect or re-authenticate a provider, confirm a model is available, and rerun `diffowl init`.

### 4. Run Your First Review

```bash
diffowl review
```

Read the latest report at `.diffowl/reviews/latest.md`, or install the optional resolution skill below to let a coding agent investigate and handle findings.

If a review reports an authentication or provider failure:

1. Run `opencode`.
2. Connect or re-authenticate the provider and confirm the configured model is available.
3. Retry with `diffowl review`.

For a timeout, retry with less context:

```bash
diffowl review --depth shallow
```

---

## Resolve Findings With an Agent

DiffOwl can use an inexpensive model for review generation while a stronger coding agent verifies and resolves the resulting findings. The optional `diffowl-resolve` skill works with agents that support the open [Agent Skills](https://skills.sh/) format.

### Install the skill

Install the `diffowl-resolve` skill:

```bash
npx skills add gutierrezje/diffowl --skill diffowl-resolve
```

The skills CLI installs into the current project by default. Restart or reload your agent if it does not immediately discover the new skill.

### Use the skill

First generate a review:

```bash
diffowl review
```

Then ask your coding agent in plain language:

```text
Resolve the latest DiffOwl review.
```

Other useful prompts:

```text
Investigate finding 2 in the latest DiffOwl review.
Resolve all open DiffOwl reviews.
Resolve the latest 3 DiffOwl reviews.
Check whether the older DiffOwl findings have already been fixed.
Archive fully resolved DiffOwl reviews.
```

The agent will:

1. Treat findings as candidates and verify them against the current code.
2. Fix confirmed issues using the repository's normal workflow.
3. For durable findings (0.3+), record lifecycle status with `diffowl findings fix`, `dismiss`, or `defer`.
4. For legacy reports, mark findings as fixed, already fixed, agent dismissed, user dismissed, deferred, or open in a `## Resolution` checklist.
5. Append or merge resolution state without rewriting the generated review body.
6. Move fully handled timestamped reports into `.diffowl/reviews/resolved/` when every finding is complete.

`latest.md` is only a copy of the newest report and is overwritten by future reviews. Markdown reports from 0.3+ are immutable snapshots; SQLite is the authoritative backlog for durable findings.

For legacy pre-0.3 reports, resolution state is appended under `## Resolution`. To reopen the OpenCode session for an archived report, pass its explicit path:

```bash
diffowl chat .diffowl/reviews/resolved/review-<timestamp>.md
```

### What the statuses mean

| Status          | Meaning                                                       | Complete? |
| --------------- | ------------------------------------------------------------- | --------- |
| Fixed           | The agent changed code or configuration and verified the fix. | Yes       |
| Already fixed   | Current code no longer exhibits the reported issue.           | Yes       |
| Agent dismissed | Investigation showed the finding was noise or incorrect.      | Yes       |
| User dismissed  | You explicitly chose not to address the finding.              | Yes       |
| Deferred        | The issue is valid but intentionally left for later.          | No        |
| Open            | The finding has not been fully investigated.                  | No        |

Reports containing deferred or open findings remain in `.diffowl/reviews/`. DiffOwl never deletes review history automatically.

### Troubleshooting

- **No review exists:** Run `diffowl review` first, or install `diffowl hook install` and make a commit.
- **The agent does not load the skill:** Verify project installation with `npx skills list` or global installation with `npx skills list --global`, then restart or reload the agent.
- **The skill is installed for the wrong agent:** Reinstall with `--agent <agent-name>`, or use `--agent '*'` to install for every detected agent.
- **A hook review timed out:** Run the retry command shown by the next foreground DiffOwl command, or retry manually with `diffowl review --commit <sha> --depth shallow`.
- **You prefer manual resolution:** Edit code normally; the skill is optional and does not affect the DiffOwl CLI.

---

## CLI Reference

### `diffowl` (or `diffowl review`)

Runs a code review on your repository.

- **Default**: Reviews the changes in the **last commit**.
- `--staged`: Reviews currently **staged changes** instead of the last commit.
- `--commit <ref>`: Reviews a specific commit ref instead of the last commit.
- `--hook`: Runs in background, non-blocking mode (used by Git hook).
- `--depth <depth>`: Overrides configured review depth. Valid values: `shallow`, `default`.
- `--reasoning <effort>`: Overrides configured OpenCode reasoning variant. Valid values: `auto`, `none`, `minimal`, `low`, `medium`, `high`, `max`, `xhigh`.
- `--verbose`: Includes suppressed findings and extra review details in the report.
- `--format <format>`: Output format: `text` (default) or `json`. JSON writes a versioned document to stdout and persists SQLite state.

Candidates below `min_confidence` or outside changed files are excluded from actionable finding counts and review status. When any are excluded, the report includes a short diagnostic summary and points to `diffowl chat` for investigation. Outside-file candidates are shown in full with `--verbose`; below-threshold candidates remain available in the OpenCode session.

Rendered findings use stable `Finding N` headings. Reports from DiffOwl 0.3+ also include durable `fnd_*` IDs and observation classification (`new`, `existing`, `regressed`), making prompts such as “investigate finding 2” or `diffowl findings show fnd_abc` map directly to the backlog.

Review depth controls both how much local context DiffOwl preloads and how much exploration the reviewer is expected to do:

- `shallow`: Cheap, surface-level review. Uses a smaller diff-centered prompt with no AI tools enabled. It is expected to miss deeper issues, but can catch obvious local bugs such as off-by-one errors, inverted conditions, unsafe null handling, missing awaits, and implementation anti-patterns visible in the diff.
- `default`: Normal review. Includes changed TypeScript AST symbols, small file excerpts, related tests, and bounded Potential Call Flow snippets from `git grep`. Permissionless read/search tools are enabled for targeted exploration when context is incomplete; permission prompts are rejected.

```bash
# Review last commit
diffowl

# Review staged files
diffowl review --staged

# Review a specific commit
diffowl review --commit abc1234

# Include suppressed outside-file findings in the report
diffowl review --staged --verbose

# Request a high reasoning variant for models that support it
diffowl review --staged --reasoning high
```

### `diffowl model`

View or interactively change the active AI model.

```bash
# Interactively pick a model
diffowl model

# Manually set a model
diffowl model opencode/big-pickle
```

### `diffowl chat [report]`

Opens the OpenCode session associated with a review report. DiffOwl hands control to the OpenCode TUI rather than implementing a separate chat interface.

```bash
# Interactively select a review
diffowl chat

# Open a specific timestamped report directly
diffowl chat review-2026-06-07T07-30-42-762Z.md

# Use an explicit relative or absolute report path
diffowl chat ./.diffowl/reviews/latest.md
```

Without an argument, DiffOwl displays active and resolved timestamped reports newest first. Bare filenames are resolved under `.diffowl/reviews/`, so agents and scripts can open a report deterministically without using the picker. Each chat-capable report stores its OpenCode session ID and project root in YAML frontmatter. Reports created before this feature and documentation-only skip reports do not have an OpenCode session to reopen.

### `diffowl hook install | status | uninstall`

Installs or removes a managed post-commit Git hook that runs reviews automatically and asynchronously in the background.

```bash
# Install non-blocking post-commit review hook
diffowl hook install

# Check whether the hook is installed and up to date
diffowl hook status

# Uninstall the hook
diffowl hook uninstall
```

_Runs reviews asynchronously in the background, saving execution output to `.diffowl/hook.log` and the latest report to `.diffowl/reviews/latest.md`. Hook reviews use the configured `context.depth`, return control to your terminal instantly, and avoid clobbering any existing post-commit hook scripts._

Only one hook review runs per project at a time. Each commit is recorded under `.diffowl/pending-reviews/`, and a background worker processes pending commits in order. Successful reviews remove their marker; failed reviews remain pending and are retried when a later commit triggers the hook. Review failures are recorded with their commit SHA in `.diffowl/last-hook-status.json` and reported on the next foreground review with commands to retry at default or shallow depth. Result files without a matching pending marker are removed automatically.

### `diffowl server start | stop | status`

Manually manage the OpenCode server lifecycle.

```bash
# Check if OpenCode serve is running
diffowl server status

# Start it manually
diffowl server start

# Stop the server
diffowl server stop
```

### `diffowl findings [list] | show | dismiss | defer | fix | reopen`

Inspect and manage the durable findings backlog stored in the repo's shared `.diffowl/state.db`.

```bash
# List unresolved findings (open and regressed)
diffowl findings

# Inspect one finding by full id, id prefix, or latest:N
diffowl findings show fnd_abc --format json

# Mark fixed after verification
diffowl findings fix fnd_abc --note "Added null guard." --verified-by "pnpm run test"

# Dismiss a false positive
diffowl findings dismiss fnd_abc --reason "Guarded by caller."

# Defer intentionally
diffowl findings defer fnd_abc --reason "Needs upstream change."

# Reopen a previously fixed or dismissed finding
diffowl findings reopen fnd_abc --reason "Regression in new path."
```

The unresolved backlog is durable: a finding does not auto-resolve just because a later review fails to mention it. Absence from a later model review never marks a finding fixed.

---

## Configuration (`.diffowl.yml`)

Your `.diffowl.yml` configures everything for DiffOwl in your project:

```yaml
# Model to use for reviews (provider/model)
model: opencode/big-pickle

# OpenCode server settings
server:
  port: 4096
  auto_start: true

# Local review context strategy: shallow or default
context:
  depth: default

# OpenCode model variant for reasoning/thinking effort.
# auto leaves the selected model/provider default alone.
reasoning:
  effort: auto

# Hook log retention. Set to 0 for unlimited retention.
retention:
  # Before each hook review, retain approximately this many KiB
  # of previous hook.log output. The new run may exceed this target.
  hook_log_kb: 1024

# Review timeout in seconds
timeout: 300

# Minimum confidence level of findings to report: low, medium, or high
min_confidence: medium

# Skip reviews when every changed file is documentation-like
skip_doc_only: false

# Include suppressed outside-file findings and extra details in reports
verbose: false

# Review scope
include:
  - "src/**/*"
  - "lib/**/*"

exclude:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*.lock"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"

# Custom project-specific review rules
rules:
  - "Check for potential security vulnerabilities like SQL injection or SSRF"
  - "Flag any hardcoded secrets, tokens, or private keys"
  - "Suggest readability and architectural improvements where relevant"
```

---

## Review Files

Each completed review starts with a timestamped report and an ephemeral `latest.md` copy. Durable state and reports are anchored to the repository's primary checkout, so linked Git worktrees share one backlog. Checkout-scoped runtime files such as hook status, hook logs, and `server.pid` stay in that checkout's local `.diffowl/`. The optional resolution skill moves fully handled timestamped reports into the resolved archive:

```text
.diffowl/state.db                                 # Authoritative review and finding state (0.3+)
.diffowl/reviews/review-<timestamp>.md           # Immutable markdown export snapshot
.diffowl/reviews/latest.md                       # Ephemeral copy of the newest report
.diffowl/reviews/resolved/review-<timestamp>.md  # Fully handled report archived by the skill
```

Review reports include YAML frontmatter similar to:

```yaml
---
diffowl:
  schema_version: 1
  review_id: rev_...
  session_id: ses_...
  project_root: /path/to/project
---
```

Finding headings in 0.3+ reports look like:

```md
#### Finding 1 (`fnd_...`) — **new**

**[WARNING] src/auth.ts:12**
Missing null check
```

This metadata is used by `diffowl chat`. For legacy pre-0.3 reports, agents may append a `## Resolution` section. For 0.3+ reports, use `diffowl findings *` only—do not edit markdown. DiffOwl does not delete review history automatically.

### Upgrading to 0.3

- **No import step**: Existing markdown reports remain unchanged and chat-capable. They are not imported into SQLite.
- **New reviews persist state**: After upgrading, each `diffowl review` writes both SQLite state and a markdown snapshot.
- **Backlog semantics change**: Use `diffowl findings` for the unresolved backlog. Markdown `### Status` reflects the review snapshot only.
- **Resolution workflow**: Prefer `diffowl findings fix|dismiss|defer` over editing report checklists when durable findings exist. Never mark fixed without recorded verification (`--verified-by`).
- **Not in 0.3**: Semantic deduplication beyond fingerprint matching, automatic resolution when findings disappear, legacy report migration, retention cleanup, and SARIF export.

---

## Developing

Clone the repository and link the CLI globally:

```bash
git clone https://github.com/gutierrezje/diffowl.git
cd diffowl
pnpm install
pnpm run build
pnpm link --global
```

When making edits to `src/**`, rebuild to update the linked CLI and git hooks:

```bash
pnpm run build
git add -p
diffowl review --staged
```

To verify model discovery against an authenticated OpenCode server already running on port 4096:

```bash
DIFFOWL_INTEGRATION=1 pnpm exec vitest run src/opencode/models.integration.test.ts
```

Set `DIFFOWL_OPENCODE_PORT` when the server uses a different port. This live test is skipped during the normal test suite.

---

## License

MIT © [Jesus Gutierrez](https://github.com/gutierrezje)
