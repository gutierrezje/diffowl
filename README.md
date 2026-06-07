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
- **Configurable Retention**: Bounds timestamped review history and accumulated hook logs without affecting active reviews.

---

## Quick Start

### 1. Prerequisites

1. **Install OpenCode CLI**:
   ```bash
   npm i -g opencode-ai
   ```
2. **Set up a Provider & Model**:
   Run `opencode` in your terminal, connect a provider (e.g., GitHub Copilot, OpenAI, Ollama, etc.), and verify it is active.

### 2. Install DiffOwl

Clone the repository and build/link the CLI globally:

```bash
git clone https://github.com/gutierrezje/diffowl.git
cd diffowl

# Using pnpm (recommended)
pnpm install && pnpm run build && pnpm link --global

# Or using npm
npm install && npm run build && npm link -g
```

### Developing

When making edits to `src/**`, rebuild to update your globally linked CLI and git hooks:

```bash
pnpm run build
git add -p
diffowl review --staged
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
> **Ensure OpenCode is configured first!** Before running `diffowl init`, make sure you have run the `opencode` CLI/UI at least once to authenticate and connect a provider (like GitHub Copilot, OpenAI, Ollama, etc.) with active models. If no active models are configured in OpenCode, the initialization command will fall back to a default configuration.

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
# Chat about the latest review
diffowl chat

# Select a timestamped report by filename
diffowl chat review-2026-06-07T07-30-42-762Z.md

# Use an explicit relative or absolute report path
diffowl chat ./.diffowl/reviews/latest.md
```

Bare filenames are resolved under `.diffowl/reviews/`. Each chat-capable report stores its OpenCode session ID and project root in YAML frontmatter. Reports created before this feature and documentation-only skip reports do not have an OpenCode session to reopen.

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

Only one hook review runs per project at a time. Each commit is recorded under `.diffowl/pending-reviews/`, and a background worker processes pending commits in order. Successful reviews remove their marker; failed reviews remain pending and are retried when a later commit triggers the hook. Review failures are recorded in `.diffowl/last-hook-status.json` and reported on the next foreground review.

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

# Local artifact retention. Set either value to 0 for unlimited retention.
retention:
  # Number of timestamped review-*.md reports to keep.
  # latest.md is always preserved and is not included in this count.
  reviews: 50

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

DiffOwl writes two Markdown files for each completed review:

```text
.diffowl/reviews/review-<timestamp>.md  # Immutable timestamped report
.diffowl/reviews/latest.md             # Copy of the newest completed report
```

Review reports include YAML frontmatter similar to:

```yaml
---
diffowl:
  session_id: ses_...
  project_root: /path/to/project
---
```

This metadata is used by `diffowl chat`; the rendered review output remains unchanged.

---

## License

MIT © [Jesus Gutierrez](https://github.com/gutierrezje)
