# Post-commit hook lifecycle

The hook commands install one managed non-blocking review entry, report whether
it is current, and remove only DiffOwl's managed section.

## Sub-features

- `hook-install-status` installs or updates the hook and reports it current,
  including the portable tracked bridge and machine-local launcher split in a
  Husky repository.
- `hook-uninstall` removes the managed DiffOwl entry without harming unrelated
  hook content.
- `agent-hook-install-summary` installs the supported session-start summary hook
  in the disposable client configuration.

## Controller

Preview with `control-diffowl run cli <feature-id> --dry-run --json`. The
controller's automated path covers the Git hook; use `cli new-run` plus this
recipe for `agent-hook-install-summary`.

## How to get to it (user POV)

- Run `diffowl hook install` in a Git repository.
- Run `diffowl hook status`.
- Run `diffowl hook uninstall`.

## Driving it with the capture harness

Preconditions:

- Use the configured scratch repository.
- Add a harmless non-DiffOwl line to `.git/hooks/post-commit` only when verifying
  preservation of an existing hook.

- **Install.** Capture `node "$DIFFOWL_BIN" hook install`. Exit is `0`. Copy
  `.git/hooks/post-commit` into the evidence directory and inspect the managed
  markers plus the absolute built entrypoint.
- **Status.** Capture `node "$DIFFOWL_BIN" hook status`. It reports installed
  and up to date.
- **Idempotence.** Run install once more when the change touches convergence.
  The hook contains one managed entry.
- **Husky ownership.** Configure the scratch with `core.hooksPath=.husky/_`,
  add harmless shared content to `.husky/post-commit`, and ignore Husky's `_`
  directory. Capture install and inspect both layers: the tracked user hook has
  one portable managed bridge and no absolute runtime paths; the Git-local
  `hooks/diffowl-post-commit` launcher has the absolute built entrypoint. Commit
  the bridge with hooks disabled, reinstall, and prove the tracked worktree
  remains clean while status reports current.
- **Uninstall.** Capture `node "$DIFFOWL_BIN" hook uninstall`, then inspect the
  hook file and Git-local launcher. The managed entry and launcher are gone,
  while unrelated Husky content remains.

## Gotchas

- Installing a hook in the DiffOwl source checkout can launch background reviews
  on later commits; the scratch boundary is mandatory.
- Hook installation proof is the resulting file, not the green terminal line.
- This offline recipe does not prove that a provider-backed worker completes a
  review. Use `opencode-hook-review` for that journey.
