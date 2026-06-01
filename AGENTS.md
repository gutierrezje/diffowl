# DiffOwl

Local AI code review CLI. Orchestrates headless OpenCode server, delegates repo analysis to local agent.

## Architecture

- `src/cli.ts` — Commander entry point. All commands defined inline.
- `src/config.ts` — `.diffowl.yml` load/save. Searches upward from cwd. Deep-merges with defaults.
- `src/opencode/` — OpenCode SDK integration
  - `client.ts` — `runReview()`, `getAvailableModels()`. SSE streaming, session lifecycle.
  - `server.ts` — Process spawn / health check / stop. Detached, PID tracked in `.diffowl/server.pid`.
  - `agent.ts` — System prompt (`REVIEW_AGENT_PROMPT`) + `buildReviewPrompt()`.
- `src/git/` — Git operations
  - `diff.ts` — `git diff/show` parsing into `DiffResult`. Hand-rolled line parser.
  - `hooks.ts` — Post-commit hook install/uninstall. Generates shell script with managed section markers.
- `src/review/` — Output formatting
  - `formatter.ts` — Markdown colorization, report write to `.diffowl/reviews/`, `latest.md`.

## Tech Stack

- TypeScript 6, ESM, Node 22+
- Build: tsup → `dist/cli.js`
- Test: vitest
- Lint: oxlint, Format: oxfmt
- Runtime deps: commander, chalk, ora, execa, yaml, @opencode-ai/sdk

## Conventions

- ESM only. Import paths include `.js` extension.
- Node built-ins over third-party where possible.
- Shell out via `execa`, never raw `child_process`.
- Config defaults in `DEFAULT_CONFIG` object; always deep-merge.
- Spinner pattern: start → update text → stop/succeed/fail. Never leave spinning.
- CLI errors: `chalk.red` + `process.exit(1)`. Hook mode exits 0 even on failure.
- Report timestamps use `ISOString().replace(/[:.]/g, "-")`.
- Static verification: Always run `pnpm run lint` (which executes both oxlint and `tsc --noEmit`) before committing. Unit tests are heavily mocked and will miss simple ReferenceErrors.
- /tdd skill always for any moderate to large change

## Anti-Patterns / Gotchas

- `REVIEW_AGENT_PROMPT` is a large markdown template. Preserve exact heading structure and severity labels — the formatter regex depends on them.
- `parseDiff` is regex-based and brittle. Test against real `git diff` output when touching.
- `runReview` SSE event loop has a 5-min safety timeout and complex `settled` flag logic. Race conditions easy to introduce.
- `spawnServer` writes PID to `.diffowl/server.pid`; `stopServer` reads it. PID reuse edge case unhandled.
- Hook script uses `shellQuote` with single-quote escaping. Never inject unsanitized paths.
- `buildReviewPrompt` concatenates user-supplied `rules` and glob patterns directly into prompt. No sanitization — assume trusted config.

## Dogfooding (run locally, then commit)

- **One-time setup**:
  - `pnpm install`
  - `pnpm run build`
  - `pnpm link --global` (installs the `diffowl` binary on your PATH)
  - `diffowl init` (creates `.diffowl.yml` and selects a model)

- **Review staged changes (recommended loop)**:
  - Stage your work: `git add -p` (or `git add .`)
  - Run: `diffowl review --staged`
  - Read: `.diffowl/reviews/latest.md`
  - Verify static type safety: `pnpm run lint` (runs oxlint and `tsc --noEmit`)
  - Iterate until clean, then commit: `git commit -m "..."` (or your preferred flow)

- **Review last commit**:
  - `diffowl review`

- **Dogfood hook mode** (non-blocking post-commit review):
  - Install: `diffowl hook install`
  - Make a commit as usual; the hook should run `diffowl review --hook` and write `.diffowl/reviews/latest.md`

- **Keeping the hook on the latest code while developing DiffOwl**:
  - After changing `src/**`, re-run `pnpm run build` so `dist/cli.js` is up to date.
  - If you’re using `pnpm link --global`, the `diffowl` shim will pick up the updated `dist/cli.js` after rebuilding.
