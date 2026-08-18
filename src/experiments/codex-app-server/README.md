# Codex App Server human-gated harness

These tests are deliberately skipped unless their exact opt-in flag is set. They are operational experiments, not the normal DiffOwl test suite, and they never perform login or change production OpenCode code.

## Protocol compatibility

```bash
DIFFOWL_CODEX_PROTOCOL_LIVE=1 pnpm run spike:codex:protocol-live
```

This runs the real Codex CLI protocol generator and records only redacted hashes and counts.

## Operational App Server run

An existing ChatGPT/Codex login is required. The run can incur model usage and cost.

```bash
export DIFFOWL_CODEX_APP_SERVER_LIVE=1
export DIFFOWL_CODEX_MODEL=gpt-5-codex
export DIFFOWL_CODEX_ARTIFACT_DIR=/tmp/diffowl-codex-artifacts
pnpm run spike:codex:live
```

`DIFFOWL_CODEX_EXECUTABLE` optionally overrides the Codex executable; it defaults to `codex`. The harness uses `codex app-server --stdio`, runs marker and output-schema reviews, exercises cancellation, and checks the isolated unauthenticated path. API keys are removed at the App Server child boundary and are never written to artifacts.

## Matched Codex/OpenCode comparison

This is directional experimentation only. It makes no parity or GO claim.

```bash
export DIFFOWL_CODEX_MATCHED_LIVE=1
export DIFFOWL_CODEX_MODEL=gpt-5-codex
export DIFFOWL_OPENCODE_MODEL=provider/model
export DIFFOWL_CODEX_ARTIFACT_DIR=/tmp/diffowl-codex-artifacts
pnpm run spike:codex:matched
```

The comparison materializes the seeded-positive `off-by-one-slice` and clean `harmless-trim` corpus cases into separate repositories, runs the real review pipeline for each side, compares prompt/context hashes, and writes collision-safe mode-0600 JSON under the mode-0700 artifact directory. Artifacts contain case/config metadata, hashes, protocol/process evidence, usage, session/thread IDs, and finding coordinates/counts only; they exclude prompts, context, source/diff content, finding prose, environment values, account data, tokens, stderr, stacks, and causes.

## Normal verification

```bash
pnpm run spike:codex:test
pnpm run lint
```

Without the explicit live flags, the operational and matched tests remain skipped.
The operational live test makes two model calls (one marker and one
output-schema) plus a separate cancellation turn; the matched test makes one
Codex and one OpenCode review call per corpus case. Existing ChatGPT and
OpenCode logins are required, and model usage may incur cost. The repository
guard covers tracked, staged, unstaged, and explicitly untracked paths;
git-ignored dependency trees are intentionally outside its scope. Emergency
interrupt and teardown cleanup can extend beyond the review timeout. The
unchanged legacy persistence record still stores the requested OpenCode model
while the Codex effective model is recorded separately. No GO decision is
available until the human-gated live and matched commands actually pass.
