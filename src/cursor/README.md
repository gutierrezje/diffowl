# Cursor SDK backend

The opt-in `cursor` backend uses pinned `@cursor/sdk` 1.0.31. It does not invoke
`cursor-agent acp` or use the Cursor CLI credential store.

```sh
diffowl cursor login
diffowl cursor models
diffowl backend cursor
diffowl model composer-2.5
diffowl review --staged
```

Login uses Cursor's browser flow to create a named 90-day SDK key. Alternatively,
set `CURSOR_API_KEY`. `cursor status` reports the source without printing the key.
Reviews are billed to that Cursor account. Model ids come from the account's
catalog; reasoning overrides are rejected until SDK model parameters are wired.

## Execution

`executor.ts` builds DiffOwl's canonical prompt and owns the worker process, total
review deadline, cancellation, and temporary SDK store. It creates that store
outside the target repository and removes it after cleanup. The package ships
`dist/cursor-worker.js` alongside the CLI; the SDK remains an external dependency
so its platform assets and dynamic imports keep their published layout.

`worker.ts` creates one SDK agent and uses the existing review-document parser
and bounded repair feedback. Node IPC carries a small validated protocol,
independent of SDK stdout or stderr. Usage is aggregated across attempts. The
effective model is recorded only when the SDK reports it.

Before accepting a result, the worker awaits SDK disposal. The parent waits for
process exit, rejects abnormal exits and unexpected surviving POSIX process-group
members, and compares repository snapshots. Cancellation has a bounded grace
period before process-tree termination. Windows uses `taskkill /T /F` while the
worker is still alive. A failed teardown cannot produce a successful review.

## Read-only policy and limits

- Allowed tools: `read`, `grep`, `glob`, `ls`.
- Explicitly excluded: `shell`, `mcp`, `task`; no host MCP callbacks are supplied.
- `settingSources: []` disables ambient user/project settings and hooks. This is
  required: the feasibility test showed a project hook could write independently
  of the model's tool allowlist.
- Unexpected tool, task, or host-interaction events reject the review.
- SDK retries are disabled; DiffOwl owns review validation and the deadline.
- Other provider credentials and Node preload controls are filtered from the
  worker environment. The official SDK authentication inputs remain available.

This is a tool policy, not an OS sandbox, filesystem-read boundary, or network
isolation guarantee. The existing repository guard observes Git-visible changes,
HEAD, index, and untracked file contents; it does not scan every ignored file or
prove that no transient write occurred. Live verification additionally hashes
the small fixture's ignored files. Active use of the target checkout during a
review can trigger the guard.

The SDK browser-login command uses the account's credential store outside any
disposable verification repository. Run it only when sign-in is intended. Offline
tests use a synthetic worker; they do not make paid SDK calls.
