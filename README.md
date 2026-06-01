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

DiffOwl is a lightweight CLI that integrates into your Git workflow to provide high-quality code reviews locally. Instead of rebuilding LLM integrations or managing provider keys from scratch, DiffOwl orchestrates a headless [OpenCode Server](https://opencode.ai/docs/server/) session and delegates the repository analysis to the local agent, which uses its own advanced reasoning and file tools.

---

## Features

- **Powered by OpenCode**: Integrates seamlessly with OpenCode's local environment, supporting 75+ AI models, tool use, and codebase indexing.
- **First-Class TypeScript Support**: Automatically extracts modified TypeScript AST nodes (functions, classes, interfaces) to feed rich, structured context to the AI reviewer. To keep installation lightweight, the compiler is dynamically loaded from your project workspace at runtime, saving ~50MB of base package bloat.
- **Non-Blocking Git Hooks**: Runs asynchronously in the background. It will never slow down or block your `git commit` or `git push` operations.
- **Review Depth Profiles**: Choose `shallow`, `default`, or `deep` context strategies to match fast hooks, normal reviews, or TypeScript impact analysis.
- **Intelligent File Filtering**: Supports `include` and `exclude` glob patterns to focus reviews on source directories while skipping build artifacts, lockfiles, and node modules.
- **Project-Specific Rules**: Inject custom guidelines directly into the reviewer's system prompt (e.g., "Check for SQL injection", "Ensure TypeScript types are explicit").
- **Interactive Model Selector**: Automatically queries OpenCode to present a clean, interactive list of your connected providers and models.
- **Local Reports**: Generates comprehensive markdown reviews and saves them locally under `.diffowl/reviews/` for easy viewing.

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

1. Start an OpenCode server (if not already running).
2. Fetch your connected providers and active models.
3. Allow you to select a model interactively.
4. Generate a `.diffowl.yml` configuration file in the project root.

> [!IMPORTANT]
> **Ensure OpenCode is configured first!** Before running `diffowl init`, make sure you have run the `opencode` CLI/UI at least once to authenticate and connect a provider (like GitHub Copilot, OpenAI, Ollama, etc.) with active models. If no active models are configured in OpenCode, the initialization command will fall back to a default configuration.

---

## CLI Reference

### `diffowl` (or `diffowl review`)

Runs a code review on your repository.

- **Default**: Reviews the changes in the **last commit**.
- `--staged`: Reviews currently **staged changes** instead of the last commit.
- `--hook`: Runs in background, non-blocking mode (used by Git hook).
- `--depth <depth>`: Overrides configured review depth. Valid values: `shallow`, `default`, `deep`.

Review depth controls both how much local context DiffOwl preloads and how much exploration the reviewer is expected to do:

- `shallow`: Cheap, surface-level review. Uses a smaller diff-centered prompt with no AI tools enabled. It is expected to miss deeper issues, but can catch obvious local bugs such as off-by-one errors, inverted conditions, unsafe null handling, missing awaits, and implementation anti-patterns visible in the diff.
- `default`: Normal review. Includes changed TypeScript AST symbols, small file excerpts, related tests, and reference hints. Read/search tools are enabled for targeted exploration when context is incomplete, especially before claiming fields, branches, validation, or wiring are missing or ignored.
- `deep`: High-effort TypeScript impact review. Adds AST outlines and static impact graph hints for changed symbols. Read/search tools and shell inspection are enabled, with emphasis on callers, callees, related tests, config, and cross-module behavior that may be affected further down the call graph.

```bash
# Review last commit
diffowl

# Review staged files
diffowl review --staged

# Run a deeper TypeScript impact review
diffowl review --staged --depth deep
```

### `diffowl model`

View or interactively change the active AI model.

```bash
# Interactively pick a model
diffowl model

# Manually set a model
diffowl model opencode-go/big-pickle
```

### `diffowl hook install | uninstall`

Installs or removes a managed post-commit Git hook that runs reviews automatically and asynchronously in the background.

```bash
# Install non-blocking post-commit review hook
diffowl hook install

# Uninstall the hook
diffowl hook uninstall
```

_Runs reviews asynchronously in the background, saving execution output to `.diffowl/hook.log` and the latest report to `.diffowl/reviews/latest.md`. Hook reviews use the configured `context.depth`, return control to your terminal instantly, and avoid clobbering any existing post-commit hook scripts._

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

# Local review context strategy: shallow, default, or deep
context:
  depth: default

# Minimum confidence level of findings to report: low, medium, or high
min_confidence: medium

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

## License

MIT © [Jesus Gutierrez](https://github.com/gutierrezje)
