# OpenCode SDK Integration

**Generated:** 2026-06-07
**Commit:** a9a51e5

Manages the OpenCode server lifecycle, SSE session streaming, and the review agent prompt.

## Where to Look

| Task                                                    | Location                                |
| ------------------------------------------------------- | --------------------------------------- |
| Run a review end-to-end                                 | `client.ts`                             |
| Spawn / stop / health-check server                      | `server.ts`                             |
| Edit system prompt or user prompt builder               | `agent.ts`                              |
| Parse agent JSON response                               | `review-parser.ts`                      |
| Timeout / settlement / reconciliation logic             | `settlement.ts`                         |
| Tool policy (read/search only) and permission rejection | `tools.ts`                              |
| Model metadata / reasoning variant resolution           | `client.ts` (`resolveReasoningVariant`) |

## Conventions

- Server is detached (`stdio: "ignore"`, `unref()`). PID tracked in `.diffowl/server.pid`.
- All OpenCode requests wrapped with `withOpenCodeDiagnostics` for structured error messages.
- SSE events filtered by `sessionId`; permission requests auto-rejected.
- Agent must emit `FINAL_REVIEW_JSON` followed by a single JSON object. No markdown fences.

## Anti-Patterns

- `inspectReviewText` is the single review-document contract. Streaming stays `open` until the `FINAL_REVIEW_JSON` marker plus a closed JSON object; `looksLikeCompleteStructuredReview` is `inspect.kind !== "open"`. Finished views (`parseStructuredReview`, idle `ifFinished`) treat a missing marker as invalid. Invalid documents retry up to `SCHEMA_VALIDATION_MAX_ATTEMPTS` then throw; there is no drop-and-succeed path. Change prompt, parser, and detector together.
- Never increase tool permissions beyond `glob`, `grep`, `read` for default depth. Deeper tool access is rejected via `replyToPermissionRequest`.
- `resolveReasoningVariant` queries provider metadata but silently ignores failures (advisory only). Do not rely on it for correctness.
- `extractSessionId` / `extractSessionError` do deep defensive type narrowing on OpenCode payloads. Missing a new payload shape causes opaque failures.
- `isOpencodeProcess` on Windows has a three-tier fallback (PowerShell → wmic → tasklist). Modifying one tier requires checking the others.
