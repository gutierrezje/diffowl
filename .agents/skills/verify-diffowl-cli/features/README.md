# DiffOwl CLI verification map

Use the freshly built binary and one disposable scratch per feature. The shared
helper records artifact identity and command evidence; feature recipes define
the user action and observable state.

## Baseline preconditions

- Run from the DiffOwl repository root.
- Let `scratch-repo.sh` build and create the configured scratch.
- Set `DIFFOWL_BIN` to the absolute `dist/cli.js` path before changing directory.
- Treat the source checkout and its `.diffowl/` state as read-only.

## Proof and cleanup

- Capture commands with `skills/verify-diffowl/helpers/capture.sh`.
- Save changed files or database-facing JSON beside the captured action.
- A command line that merely printed success is supporting evidence, not the
  resulting-state proof.
- Clean with `helpers/cleanup.sh "$EVIDENCE"`; retain the evidence directory.

## Features

- [Version, help, and errors](version-and-errors.md): `cli-version-help`,
  `cli-invalid-command`.
- [Backend and model preferences](preferences.md): `preference-select`,
  `preference-preserve-policy`, `preference-reset`.
- [Post-commit hook lifecycle](hook-lifecycle.md): `hook-install-status`,
  `hook-uninstall`.
- [Findings inspection and disposition](findings.md): `findings-inspect`,
  `finding-disposition`.
- [Interactive setup](init.md): `init-codex-setup`.
