# DiffOwl

**Generated:** 2026-07-09
**Commit:** 449f08c

Local AI code review CLI. Orchestrates a headless OpenCode server and delegates repo analysis to a local agent.

## Agent skills

### Issue tracker

Issues and Wayfinder maps live in the Linear `DiffOwl` project under the `Creator` team. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage labels configured in Linear. See `docs/agents/triage-labels.md`.

### Domain docs

DiffOwl uses a single-context domain-doc layout. See `docs/agents/domain.md`.

## Structure

```
.
├── src/
│   ├── cli.ts              # Commander entry point
│   ├── config.ts           # .diffowl.yml load/save
│   ├── opencode/ (AGENTS.md)   # OpenCode SDK integration
│   ├── git/ (AGENTS.md)        # Git diff / hooks
│   ├── eval/                   # Measured review quality harness
│   ├── state/                  # Durable findings state (SQLite)
│   ├── output/                 # JSON contract & findings rendering
│   └── review/ (AGENTS.md)     # Output formatting & context
├── package.json
└── tsup.config.ts
```

## Where to Look

| Task                                              | Location                                                |
| ------------------------------------------------- | ------------------------------------------------------- |
| Add CLI command                                   | `src/cli.ts`                                            |
| Run eval harness                                  | `src/eval/command.ts`, `pnpm run eval`                  |
| Corpus manifest / fixtures                        | `eval/corpus-manifest.json`, `eval/corpus/`             |
| Compare eval runs vs baseline                     | `src/eval/compare.ts`, `--compare` on `diffowl eval`    |
| Change review prompt / agent behavior             | `src/opencode/agent.ts`                                 |
| Tweak diff parser                                 | `src/git/diff.ts`                                       |
| Change report format                              | `src/review/formatter.ts`                               |
| Review pipeline engine                            | `src/review/run.ts`                                     |
| Add context source (AST, refs)                    | `src/review/context.ts`, `src/review/ast/`              |
| Adjust server lifecycle                           | `src/opencode/server.ts`                                |
| Handle SSE events / settlement                    | `src/opencode/client.ts`, `src/opencode/settlement.ts`  |
| Findings lifecycle (resolve/dismiss/defer/reopen) | `src/state/lifecycle.ts`, `src/state/findings-query.ts` |
| Persist review runs / reconcile findings          | `src/state/persist.ts`, `src/state/reconcile.ts`        |
| Finding fingerprints / durable ids                | `src/state/fingerprint.ts`                              |
| `--format json` review document                   | `src/output/json.ts`                                    |
| Findings list/detail CLI rendering                | `src/output/findings.ts`                                |
| Verify CLI end-to-end (agent skill)               | `skills/verify-diffowl/`                                |

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

- `inspectReviewText` is the single review-document contract. Streaming stays `open` until the `FINAL_REVIEW_JSON` marker plus a closed JSON object; `looksLikeCompleteStructuredReview` is `inspect.kind !== "open"`. Finished views (`parseStructuredReview`, idle `ifFinished`) treat a missing marker as invalid. Invalid documents retry up to `SCHEMA_VALIDATION_MAX_ATTEMPTS` then throw; there is no drop-and-succeed path. Change prompt, parser, and detector together.
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

# Review loop
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

## Cursor Cloud specific instructions

- The base env supplies Node `>=22.14.0` and pnpm; bootstrap with `pnpm install --frozen-lockfile`.
- Full `diffowl review`/`eval` needs an external OpenCode provider (`npm i -g opencode-ai`, then authenticate). Offline surfaces (`hook`, `findings`, config, build/lint/test) run without it.
- `pnpm run test` creates hundreds of throwaway git repos and commits. When the global git config enables commit signing (Cursor Cloud sets `commit.gpgsign=true` with an SSH signing program), every test commit blocks on the signer and the suite times out. Run tests with signing disabled:

  ```bash
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false pnpm run test
  ```

  This drops the suite from ~4.5 min (with timeouts) to ~15s and does not touch your global config or the agent's own signed commits.
