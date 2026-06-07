# Git Operations

**Generated:** 2026-06-07
**Commit:** a9a51e5

Diff collection, hand-rolled parsing, and post-commit hook management.

## Where to Look

| Task | Location |
|------|----------|
| Parse `git diff/show` output | `diff.ts` |
| Post-commit hook install/uninstall | `hooks.ts` |
| Real diff fixtures for tests | `fixtures/` |

## Conventions

- Diff parsing is hand-rolled line-by-line, not via library.
- Hook script generated with managed section markers (`# diffowl-managed` … `# end-diffowl`).
- Hooks are non-blocking: spawns a detached worker process.

## Anti-Patterns

- `parseGitDiffLine` handles quoted and unquoted paths with prefix stripping. Edge cases in renames and combined diffs.
- `collectGitDiff` caps output at 2MB; truncated diffs produce a diagnostic but may miss files.
- Hook worker spawns the CLI via `process.execPath` + `import.meta.url` resolved path. If the build is stale, the hook runs old code.
