# Cursor SDK adapter verification

Verified 2026-09-19 on macOS arm64, Node 22.14.0, with `@cursor/sdk` 1.0.31
and account model `composer-2.5`. This records implementation verification,
not a review-quality benchmark or a cross-platform certification.

## Automated checks

- `pnpm run lint`: passed, including TypeScript and generated lint-plugin checks.
- `pnpm run build`: passed; package contains the CLI, worker, and shared chunks.
- Full suite with Git signing disabled: 86 files passed, 4 skipped;
  1,073 tests passed, 7 skipped (1,080 total).
- Frozen lockfile validation: passed.
- CLI verification recipe `cli preference-select`: VERIFIED; disposable state
  cleaned up. Cursor-specific CLI tests also preserve other backend preferences
  and verify that authentication status does not display an environment key.
- Fifteen Cursor executor tests exercise real child processes: success, invalid
  output, unexpected tools, abnormal exit, post-result data, cancellation,
  timeout, repository mutation, environment filtering, temporary-store cleanup,
  and surviving-descendant rejection. These use a synthetic worker and do not
  establish live SDK behavior by themselves.

## Live built and installed CLI

Both runs used a disposable Git repository with one staged bug:
`price * (1 - percent / 100)` changed to `price * (1 + percent / 100)`.
The fixture included tracked, untracked, and ignored sentinels plus a Cursor
project hook that would create a file if ambient hooks ran.

```sh
diffowl review --staged --backend cursor --model composer-2.5 \
  --format json --fail-on-findings
```

| Observation | Built CLI | Fresh npm package installation |
| --- | --- | --- |
| Seeded bug at `price.js:2` | Found | Found |
| Findings | 1 | 1 |
| Backend / effective model | cursor / composer-2.5 | cursor / composer-2.5 |
| Exit status | 1, expected for findings | 1, expected for findings |
| HEAD, index, worktree, fixture file hashes | Unchanged | Unchanged |
| Review and findings persisted | Yes | Yes |
| Elapsed single run | 8.996 s | 8.570 s |

The installed run used `npm pack`, a fresh installation with package scripts
disabled, and the installed `dist/cli.js`. The existing official SDK login was
used; no credentials are included in these artifacts. Auth status and model
catalog commands were also exercised live. Fixture repositories were removed.

## Scope and limits

The SDK is configured with `read`, `grep`, `glob`, and `ls`; shell, MCP, and task
tools are excluded. Ambient settings are disabled. The worker awaits SDK
disposal and the parent verifies exit and repository state before accepting a
review. The independent structural audit found no remaining scoped blockers.

This is a tool policy, not OS containment, read-path isolation, or network
isolation. The production guard does not detect every ignored or transient
write. Parent-side Git/hash work and final temporary-store removal are not
fully cancellable. Live Windows/Linux SDK runs and reasoning overrides are
outside this verification. Authentication uses the SDK's separate key flow;
Cursor CLI authentication is not reused.
