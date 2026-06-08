# Review Output & Context

**Generated:** 2026-06-07
**Commit:** a9a51e5

Builds the review context from diffs, AST, and cross-references, then renders and persists markdown reports.

## Where to Look

| Task                                       | Location                            |
| ------------------------------------------ | ----------------------------------- |
| Change report markdown format              | `formatter.ts`                      |
| Build review context (diff + files + refs) | `context.ts`                        |
| Render context into prompt markdown        | `context-render.ts`                 |
| TypeScript AST symbol extraction           | `ast/index.ts`, `ast/typescript.ts` |
| Cross-reference search (git grep)          | `context-references.ts`             |
| Hook log trimming                          | `retention.ts`                      |
| Review data types                          | `types.ts`                          |

## Conventions

- Context respects `include`/`exclude` globs and skips lockfiles.
- Changed file context truncated at 12K chars; related files at 6K; diff at 40K.
- Reference search uses `git grep` with 5s timeout and 200 match cap.
- Reports written to `.diffowl/reviews/review-{ISO}.md` and `latest.md`.
- Report timestamps: `ISOString().replace(/[:.]/g, "-")`.

## Anti-Patterns

- `renderReviewContext` embeds full file contents. Watch truncation flags to avoid prompt bloat.
- `buildReferenceContexts` shells out to `git grep`. Large repos or broad symbol names can hit the match cap.
- AST parsing is best-effort; missing parser falls back to diff + file context with a diagnostic.
- Changing `MAX_*` limits without testing against real diffs can break prompt token budgets.
