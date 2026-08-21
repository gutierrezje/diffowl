# Codex App Server adapter

This module owns DiffOwl's production Codex App Server implementation. It is not
user-selectable yet. OpenCode remains the only default runtime.

## Execution contract

`createCodexReviewExecutor` implements the review-owned `ReviewExecutor`
interface. One execution does the following in order:

1. Runs `codex --version`, `codex app-server generate-ts`, and
   `codex app-server generate-json-schema` through the configured command.
2. Rejects generated protocol output that does not contain the request,
   notification, policy, terminal-state, usage, and error fields used by the
   adapter.
3. Starts one `codex app-server --stdio` child for the review.
4. Requires an existing ChatGPT login before starting a thread or paid turn.
5. Starts an ephemeral thread with approvals denied, a read-only sandbox, and
   network access disabled.
6. Sends the shared native review output schema and validates the complete JSON
   document with the shared review validator. Invalid documents get at most two
   retries, for three total attempts.
7. Verifies repository state after the turn and again after process close.

The compatibility check and App Server review share the configured review
timeout. `protocolTimeoutMs` is an additional cap on the compatibility phase,
not a separate extension to the review budget.

Cancellation interrupts the active turn and requires an acknowledged interrupt,
terminal `interrupted` state, clean EOF, process exit, and a final unchanged
repository snapshot.

The child environment uses an allowlist. API-key, token, secret, password,
credential, and SSH-agent variables do not cross the process boundary. The
adapter accepts ChatGPT authentication only.

## Compatibility

Codex CLI 0.147.0 is the version proven by the #103 human-gated run. This is not
a claim that every later Codex CLI version is compatible. The executor checks
fresh generated TypeScript and JSON schemas before every App Server review and
fails before a paid turn when the required protocol subset changes.

## Evidence

The retained spike plan is [`plans/028-codex-app-server-backend.md`](../../plans/028-codex-app-server-backend.md).
Its sealed operational run manifest hash is
`2996a52b15f07918aa5d02db724ea80a2db88c275e94abbddaddb69de5d06e26`.
Its sealed matched run manifest hash is
`67e8b184e382bf38b47dcdf6e1d20f876bdb122927a819e3a4e8028df8377702`.
The matched result covers two cases and does not establish broad review-quality
parity.

## Verification

```bash
pnpm run test:codex
pnpm run lint
```

The human-gated commands remain under `src/experiments/codex-app-server` so they
cannot spend model usage during the normal test suite.
