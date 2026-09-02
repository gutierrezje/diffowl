# Backend and model preferences

Preference commands let a user select OpenCode or Codex and preserve one model
per backend without rewriting committed project policy.

## Sub-features

- `preference-select` switches backends and stores backend-specific models.
- `preference-model-options` stores optional model-specific choices without
  inventing one shared capability list.
- `preference-preserve-policy` leaves `.diffowl.yml` byte-for-byte unchanged.
- `preference-reset` removes only the selected preference requested by the user.

## Controller

Preview with `control-diffowl run cli <feature-id> --dry-run --json`, then run
without `--dry-run`. Inspect the preference and policy observations in the receipt.

## How to get to it (user POV)

- Run `diffowl backend`, `diffowl backend opencode`, or `diffowl backend codex`.
- Run `diffowl model <id>` for the selected backend.
- Run `diffowl backend --reset` or `diffowl model --reset`.

## Driving it with the capture harness

Preconditions:

- Use the scratch created by the CLI workflow; provider authentication is not
  required because selection must not start a review.
- Copy `.diffowl.yml` to `$EVIDENCE/policy-before.yml`.

- **Select Codex.** Capture `node "$DIFFOWL_BIN" backend codex`, followed by
  `node "$DIFFOWL_BIN" model gpt-5.4`.
- **Select OpenCode.** Capture `node "$DIFFOWL_BIN" backend opencode`, followed
  by `node "$DIFFOWL_BIN" model provider/updated-model`. This differs from the
  scratch's seeded value, so the resulting-state check is meaningful.
- **Inspect.** Capture `node "$DIFFOWL_BIN" backend`. Copy
  `.diffowl/preferences.yml` to the evidence directory. It records both models
  and the selected backend; `.diffowl.yml` still matches the before copy.
- **Reset.** Exercise only the reset behavior changed by the patch. Confirm the
  unrelated backend model remains in the preference file.
- **Model options.** When the patch adds a model-specific choice such as a
  reasoning variant, discover the actual command from `--help`, use a value from
  that backend's current model catalog, and inspect its stored scope. This CLI
  check proves selection and persistence only; use the provider skill to prove
  the runtime received it.

## Gotchas

- Preferences live under the repository's shared DiffOwl state root, not beside
  every worktree. Keep this recipe in the disposable repo.
- Use a bare Codex model ID and `provider/model` for OpenCode; format rejection is
  part of the user contract.
- Runtime availability printed by `diffowl backend` is informational. It does not
  prove authentication or a working review.
