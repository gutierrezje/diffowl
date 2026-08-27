# Version, help, and errors

These journeys prove that a user is driving the intended DiffOwl artifact and
that ordinary command discovery and rejection work without mutating project
state.

## Sub-features

- `cli-version-help` reports the package version and reachable command tree.
- `cli-invalid-command` rejects an unknown command with a nonzero exit.

## How to get to it (user POV)

- Run `diffowl -V`.
- Run `diffowl --help` or `diffowl <command> --help`.
- Run a command name DiffOwl does not support.

## Driving it with the capture harness

Preconditions:

- The CLI workflow created `SCRATCH`, `EVIDENCE`, and `DIFFOWL_BIN`.
- `receipt.txt` identifies the same binary hash under test.

- **Version.** Capture `node "$DIFFOWL_BIN" -V`. Exit is `0`, and stdout equals
  the version in the source checkout's `package.json`.
- **Help.** Capture `node "$DIFFOWL_BIN" --help`, then the affected command's
  `--help`. Exit is `0`, and the changed command or option is present once.
- **Unknown command.** Capture `node "$DIFFOWL_BIN" definitely-not-a-command`
  while allowing the expected nonzero exit. Stderr identifies an unknown
  command rather than a config, provider, or stack-trace failure.
- **State proof.** Compare `git -C "$SCRATCH" status --porcelain=v1` before and
  after. These read-only journeys add no scratch changes.

## Gotchas

- `which diffowl` may resolve to an older global link; use `DIFFOWL_BIN`.
- A semver match does not prove source identity by itself; retain the binary hash
  from `receipt.txt`.
- Commander writes some usage errors to stderr. Assert the channel and exit code,
  not only the words.
