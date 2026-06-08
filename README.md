# DiffOwl

```text
,___,
(O,O)
/)_)
" "
```

> **Local AI Code Review Agent**
>
> Build-time quality reviews, running locally, on your own terms.

DiffOwl is a lightweight CLI that integrates into your Git workflow to provide high-quality code reviews locally. Instead of rebuilding LLM integrations or managing provider keys from scratch, DiffOwl orchestrates a headless [OpenCode Server](https://opencode.ai/docs/server/) session, builds bounded local review context, and asks the local agent for structured findings.

---

## Features

- **Powered by OpenCode**: Integrates with OpenCode's local environment and configured providers while keeping DiffOwl's review workflow local and repeatable.
- **First-Class TypeScript Support**: Automatically extracts modified TypeScript AST nodes (functions, classes, interfaces, types, enums, methods, properties, and top-level const declarations) to feed rich, structured context to the AI reviewer.
- **Non-Blocking Git Hooks**: Runs post-commit reviews asynchronously in the background. It will never slow down or block your `git commit` operation.
- **Review Chat Handoff**: Reopen the OpenCode session behind the latest or any selected review with `diffowl chat`.
- **Review Depth Profiles**: Choose `shallow` or `default` context strategies to match fast hooks or normal reviews.
- **Intelligent File Filtering**: Supports `include` and `exclude` glob patterns to focus reviews on source directories while skipping build artifacts, lockfiles, and node modules.
- **Project-Specific Rules**: Inject custom guidelines directly into the reviewer's system prompt (e.g., "Check for SQL injection", "Ensure TypeScript types are explicit").
- **Interactive Model Selector**: Automatically queries OpenCode to present a clean, interactive list of your connected providers and models.
- **Local Reports**: Generates markdown reviews under `.diffowl/reviews/`, including hidden session metadata that makes reports chat-capable.
- **Agent-Assisted Resolution**: Includes an optional portable skill that lets coding agents investigate findings, fix confirmed issues, record dismissals, and archive handled reports.
- **Hook Log Retention**: Bounds accumulated hook logs without deleting review history.

---

## Quick Start

### 1. Prerequisites

1. **Verify Node.js 20 or newer is installed**:
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

Install for the current project from GitHub:

```bash
npx skills add gutierrezje/diffowl --skill diffowl-resolve
```

Install globally for all projects:

```bash
npx skills add gutierrezje/diffowl --skill diffowl-resolve --global
```

From an npm-installed copy of DiffOwl:

```bash
npx skills add "$(npm root --global)/diffowl" --skill diffowl-resolve
```

Try the skill once without installing it:

```bash
npx skills use gutierrezje/diffowl@diffowl-resolve
```

The skills CLI detects supported agents and installs the skill into the appropriate location. Project installation is the default. Use `--global` when you want the skill available across repositories. Restart or reload your agent if it does not immediately discover newly installed skills.

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
Check whether the older DiffOwl findings have already been fixed.
Archive fully resolved DiffOwl reviews.
```

The agent will:

1. Treat findings as candidates and verify them against the current code.
2. Fix confirmed issues using the repository's normal workflow.
3. Mark findings as fixed, already fixed, agent dismissed, user dismissed, deferred, or open.
4. Append a `## Resolution` checklist without rewriting the generated review.
5. Move fully handled timestamped reports into `.diffowl/reviews/resolved/`.

`latest.md` is only a copy of the newest report and is overwritten by future reviews. The skill updates the matching timestamped report as the durable record.

The generated review content remains unchanged. Resolution state is appended under `## Resolution`. To reopen the OpenCode session for an archived report, pass its explicit path:

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

Candidates below `min_confidence` or outside changed files are excluded from actionable finding counts and review status. When any are excluded, the report includes a short diagnostic summary and points to `diffowl chat` for investigation. Outside-file candidates are shown in full with `--verbose`; below-threshold candidates remain available in the OpenCode session.

Rendered findings have stable `Finding N` headings, making prompts such as “investigate finding 2” map directly to resolution checklist entries.

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
diffowl model opencode-go/big-pickle
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

---

## Configuration (`.diffowl.yml`)

Your `.diffowl.yml` configures everything for DiffOwl in your project:

```yaml
# Model to use for reviews (provider/model)
model: opencode-go/big-pickle

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

Each completed review starts with a timestamped report and an ephemeral `latest.md` copy. The optional resolution skill moves fully handled timestamped reports into the resolved archive:

```text
.diffowl/reviews/review-<timestamp>.md           # Durable timestamped report
.diffowl/reviews/latest.md                       # Ephemeral copy of the newest report
.diffowl/reviews/resolved/review-<timestamp>.md  # Fully handled report archived by the skill
```

Review reports include YAML frontmatter similar to:

```yaml
---
diffowl:
  session_id: ses_...
  project_root: /path/to/project
---
```

This metadata is used by `diffowl chat`. Agents may append a `## Resolution` section to timestamped reports, but should preserve the generated review body. DiffOwl does not delete review history automatically.

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
