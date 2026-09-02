# Git Operations

**Generated:** 2026-06-07
**Commit:** a9a51e5

Diff collection, hand-rolled parsing, and post-commit hook management.

## Where to Look

| Task                               | Location               |
| ---------------------------------- | ---------------------- |
| Parse `git diff/show` output       | `diff.ts`              |
| Post-commit hook install/uninstall | `hook-installation.ts` |
| Post-commit review queue/worker    | `hooks.ts`             |
| Real diff fixtures for tests       | `fixtures/`            |

## Conventions

- Diff parsing is hand-rolled line-by-line, not via library.
- Hook script generated with managed section markers (`# diffowl-managed` … `# end-diffowl`).
- Hooks are non-blocking: spawns a detached worker process.
- Hook result JSON includes the reviewed commit SHA so failures can print exact retry commands.
- Pending review enumeration removes orphaned `*.result.json` files but preserves results while their commit marker exists.
- Hook queue stops early on quota, auth, server, ABI, and missing OpenCode failures instead of draining the whole backlog with the same error.

## Anti-Patterns

- `parseGitDiffLine` handles quoted and unquoted paths with prefix stripping. Commit review uses a first-parent diff for merges; branch review uses the merge base through `HEAD`.
- `collectGitDiff` caps output at 2MB; truncated diffs produce a diagnostic but may miss files.
- Hook worker spawns the CLI via `process.execPath` + `import.meta.url` resolved path. If the build is stale, the hook runs old code.
