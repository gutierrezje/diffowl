# DiffOwl

**Generated:** 2026-06-07
**Commit:** a9a51e5

Local AI code review CLI. Orchestrates a headless OpenCode server and delegates repo analysis to a local agent.

## Structure

```
.
├── src/
│   ├── cli.ts              # Commander entry point
│   ├── config.ts           # .diffowl.yml load/save
│   ├── opencode/ (AGENTS.md)   # OpenCode SDK integration
│   ├── git/ (AGENTS.md)        # Git diff / hooks
│   ├── eval/                   # Measured review quality harness
│   └── review/ (AGENTS.md)     # Output formatting & context
├── package.json
└── tsup.config.ts
```

## Where to Look

| Task                                  | Location                                               |
| ------------------------------------- | ------------------------------------------------------ |
| Add CLI command                       | `src/cli.ts`                                           |
| Run eval harness                      | `src/eval/command.ts`, `pnpm run eval`                 |
| Corpus manifest / fixtures            | `eval/corpus-manifest.json`, `eval/corpus/`              |
| Compare eval runs vs baseline         | `src/eval/compare.ts`, `--compare` on `diffowl eval`     |
| Change review prompt / agent behavior | `src/opencode/agent.ts`                                |
| Tweak diff parser                     | `src/git/diff.ts`                                      |
| Change report format                  | `src/review/formatter.ts`                              |
| Add context source (AST, refs)        | `src/review/context.ts`, `src/review/ast/`             |
| Adjust server lifecycle               | `src/opencode/server.ts`                               |
| Handle SSE events / settlement        | `src/opencode/client.ts`, `src/opencode/settlement.ts` |

## Conventions

- ESM only; imports include `.js` extension.
- Node built-ins over third-party where possible.
- Shell out via `execa`, never raw `child_process`.
- Config defaults in `DEFAULT_CONFIG`; always deep-merge.
- Spinner: start → update → stop/succeed/fail. Never leave spinning.
- CLI errors: `chalk.red` + `process.exit(1)`. Hook mode exits 0 even on failure.
- Report timestamps: `ISOString().replace(/[:.]/g, "-")`.

## Style

- Use conventional commit messages and PR titles: `type(scope): summary`.
- Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Scopes are optional; use the affected area when helpful.
- Prefer `const`, early returns, type inference, and dot notation.
- Avoid `any`, unnecessary destructuring, and premature single-use helpers.
- Keep logic inline unless a helper is reused, hides a complex boundary, or names a clear independent concept.
- Keep supporting helpers close to and below the main exported logic when that improves readability.
- Comment non-obvious constraints and surprising behavior, not routine assignments or control flow.
- Avoid mocks where practical; test observable behavior against real implementation paths.
- Use dynamic imports for heavy dependencies needed only on narrow code paths.

## Anti-Patterns

- `REVIEW_AGENT_PROMPT` exact heading structure and severity labels must be preserved — `formatter.ts` regex depends on them.
- `parseDiff` is regex-based and brittle. Test against real `git diff` output when touching.
- `runReview` SSE loop timeout is `config.timeout` (default 300s). The `settled` flag logic is complex; race conditions easy.
- `spawnServer` writes PID to `.diffowl/server.pid`; `stopServer` reads it. PID reuse edge case unhandled.
- Hook script uses `shellQuote` with single-quote escaping. Never inject unsanitized paths.
- `buildReviewPrompt` concatenates user rules/globs directly into prompt. Assume trusted config.

## Commands

```bash
pnpm run build      # tsup → dist/cli.js
pnpm run lint       # oxlint + tsc --noEmit
pnpm run test       # vitest
pnpm run build && pnpm link --global   # install diffowl binary

# Dogfood loop
# stage → diffowl review --staged → read .diffowl/reviews/latest.md → pnpm run lint → commit
diffowl init        # create .diffowl.yml
diffowl hook install
```

## Key Configs

| Tool  | File                       | Notes                     |
| ----- | -------------------------- | ------------------------- |
| Build | `tsup.config.ts`           | Single entry `src/cli.ts` |
| TS    | `tsconfig.json`            | ESM, strict               |
| CI    | `.github/workflows/ci.yml` | —                         |

## Notes

- After changing `src/**`, rebuild so the linked global binary picks up `dist/cli.js`.
- Unit tests are heavily mocked and will miss simple ReferenceErrors. Always run `pnpm run lint` before committing.
- /tdd skill always for any moderate to large change
