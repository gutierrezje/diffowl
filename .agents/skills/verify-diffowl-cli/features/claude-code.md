# Claude Code backend

Claude has no automated controller surface. Use `cli new-run preference-select`
for disposable setup and record the actual manual claim in a separate assessment
under the shared evidence contract.

## Offline selection and persistence

1. Build the changed checkout and create the disposable CLI run. Observe its
   source and binary identity with run-bound `doctor`.
2. Capture `backend claude`, `model sonnet`, and `reasoning high` through the built
   binary, then inspect the saved preferences and `backend` output. Claude must
   retain its own model and reasoning; committed policy must stay unchanged.
3. Switch to another backend and back. Reset only the selected Claude preference
   being tested and confirm the other backend preferences remain.
4. Run the process and CLI integration tests for simulated review behavior.
   Their fake executable proves persistence and error handling, not live Claude
   compatibility.

## Live review

Use only a synthetic disposable Git target. Inspect `claude --version` and
`claude auth status`; retain the authentication category, never credentials.
If authentication is missing or expired, report the live branch as inconclusive
and continue offline work. Authentication changes require the user's instruction.

Capture a built-binary `review --staged --backend claude --model sonnet --format
json`. Inspect the JSON, immutable report, persisted review/execution row,
requested and effective model, session id, usage, terminal outcome, unchanged
fixture contents, and completed process teardown. Seed an ignored-file sentinel
and an ambient project hook marker to check the actual isolation policy. Capture
Ctrl+C or a short configured deadline separately when those paths changed.

Bind the assessment to the exact source, build, Claude version, and staged diff.
Label live and simulated evidence separately. Save the report, state observations,
and relevant logs before controller cleanup; preserve blocked attempts.
