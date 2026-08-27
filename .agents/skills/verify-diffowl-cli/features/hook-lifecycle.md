# Post-commit hook lifecycle

The hook commands install one managed non-blocking review entry, report whether
it is current, and remove only DiffOwl's managed section.

## Sub-features

- `hook-install-status` installs or updates the hook and reports it current.
- `hook-uninstall` removes the managed DiffOwl entry without harming unrelated
  hook content.

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
- **Uninstall.** Capture `node "$DIFFOWL_BIN" hook uninstall`, then inspect the
  hook file. The managed entry is gone and unrelated content remains.

## Gotchas

- Installing a hook in the DiffOwl source checkout can launch background reviews
  on later commits; the scratch boundary is mandatory.
- Hook installation proof is the resulting file, not the green terminal line.
- This offline recipe does not prove that a provider-backed worker completes a
  review. Use `opencode-hook-review` for that journey.
