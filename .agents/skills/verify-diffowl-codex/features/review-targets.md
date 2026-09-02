# Codex review targets

Review target journeys prove that DiffOwl sends the selected staged, commit, or
branch diff through Codex and persists one structured result without repository
mutation.

## Sub-features

- `codex-review-last-commit` reviews the default last-commit target.
- `codex-review-staged` reviews only the index.
- `codex-review-commit` reviews one explicit commit.
- `codex-review-base` reviews committed branch changes from a merge base.

## Controller

Run `control-diffowl run codex <feature-id> --model <bare-id> --json`. The
adapter prepares the mapped target before its `before` snapshot.

## How to get to it (user POV)

- Run `diffowl review --staged --backend codex --model <id>`.
- Run `diffowl review --backend codex --model <id>` for the default last commit.
- Run `diffowl review --commit <sha> --backend codex --model <id>`.
- Run `diffowl review --base <ref> --backend codex --model <id>`.

## Driving it with the capture harness

Preconditions:

- Runtime identity and ChatGPT login are captured.
- The scratch contains a small code change shaped for the selected target.
  Capture the exact Git diff before review.

- **Drive.** Capture the selected command with `--depth shallow --format json`.
- **Document.** Parse stdout. Backend is `codex`; target kind and resolved commits
  match Git; requested and effective models are explicit; status is terminal.
- **Persistence.** Copy the report named by `review.report_path`, capture findings
  JSON, and retain the state database. When operation or execution persistence
  changed, confirm the stored operation input and execution row identify this
  same target, backend, model, role, and terminal outcome. Zero findings is
  allowed.
- **Repository guard.** Compare tracked and ignored repository snapshots before
  the turn and after child close. Only expected `.diffowl` evidence changes.

## Gotchas

- `--base` does not include staged or unstaged changes.
- A final agent message is insufficient if repository-close verification or
  process teardown fails afterward.
- Schema retries can spend more than one turn. Record actual attempts and usage
  when exposed; do not describe the run as a single-turn cost.
