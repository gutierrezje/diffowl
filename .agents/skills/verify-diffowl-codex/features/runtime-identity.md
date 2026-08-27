# Codex runtime identity and compatibility

This journey proves that DiffOwl reaches the intended Codex CLI, authenticates
through ChatGPT, accepts the generated App Server protocol, and records the
actual model used.

## Sub-features

- `codex-runtime-ready` binds a live review to the installed CLI, auth mode,
  generated protocol, requested model, and effective model.

## How to get to it (user POV)

- Run `diffowl backend` to inspect runtime availability.
- Run a Codex-backed review with an explicit model.

## Driving it with the capture harness

Preconditions:

- Use a new Codex scratch and evidence directory.
- `codex login status` succeeds. Capture only its non-secret mode/status text.

- **Runtime.** Capture `codex --version`, `codex login status`, and
  `node "$DIFFOWL_BIN" backend`. The runtime path is available and the selected
  backend/model are explicit.
- **Compatibility.** Run the smallest live staged-review recipe. Compatibility
  generation and validation finish before the paid turn. When that code changed,
  bind the result to the exact executable version and generated protocol digest;
  preserve any compatibility error as the outcome.
- **Authentication.** `codex login status` proves the CLI preflight only. When
  authentication handling changed, capture the App Server `account/read` result
  or its redacted public equivalent and require ChatGPT auth before review.
- **Provenance.** Inspect the JSON execution block and report. Record requested
  and effective model plus session/thread IDs. A reroute must be visible rather
  than silently reported as the requested model.
- **Teardown.** Compare Codex App Server process snapshots before and after. No
  child attributable to this run remains.

## Gotchas

- `codex --version` alone does not prove which child handled the review.
- A successful login preflight does not prove the child used the same account
  mode.
- A previously proven CLI version does not certify a newer generated protocol.
- A valid JSON answer with missing or false provenance is not a verified runtime
  identity.
