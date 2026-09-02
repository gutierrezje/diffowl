# OpenCode review targets

Review target journeys prove that DiffOwl sends the selected staged, commit, or
branch diff through OpenCode and persists one structured result for that target.

## Sub-features

- `opencode-review-last-commit` reviews the default last-commit target.
- `opencode-review-staged` reviews only the index.
- `opencode-review-commit` reviews one explicit commit.
- `opencode-review-base` reviews committed branch changes from a merge base.

## Controller

Run `control-diffowl run opencode <feature-id> --model <provider/model> --json`.
The adapter prepares the target and owns server start, status, and teardown.

## How to get to it (user POV)

- Run `diffowl review --staged`.
- Run `diffowl review` for the default last commit.
- Run `diffowl review --commit <sha>`.
- Run `diffowl review --base <ref>`.

## Driving it with the capture harness

Preconditions:

- The owned server is healthy and accepts the explicit model.
- The scratch contains a small code change appropriate to the selected target.
  Capture `git diff`, `git diff --cached`, or `git show` before review.

- **Drive.** Capture `node "$DIFFOWL_BIN" review <target flags> --backend
  opencode --model "$MODEL" --depth shallow --format json`.
- **Document.** Parse stdout. `review.backend` is `opencode`, requested model is
  explicit, target kind and resolved commits match the captured Git target, and
  status is a supported terminal review status. If `effective_model` is empty,
  do not extend this result into a model-identity claim.
- **Capabilities.** When model-option routing changed, record the owned server's
  advertised options, the requested native value, and whether DiffOwl forwarded,
  omitted, or rejected it. Never translate one provider's option names into
  another provider's ordering.
- **Persistence.** Resolve `review.report_path`, copy that timestamped report to
  evidence, and capture `findings list --format json`. Do not expect
  `reviews/latest.md`; reports are immutable timestamped files.
- **Safety.** Compare repository status before and after. Provider review must
  not modify tracked or ignored source files outside DiffOwl's own state.

## Gotchas

- The model may legitimately return zero findings; that is not a transport
  failure and not proof of review quality.
- A JSON parse success from the wrong target is a failed verification.
- `--base` excludes staged and unstaged work. Capture the committed range it
  actually reviews.
- Keep retries and failed attempts visible; do not overwrite action directories.
