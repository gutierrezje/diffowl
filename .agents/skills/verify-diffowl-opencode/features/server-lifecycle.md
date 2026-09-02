# Owned OpenCode server lifecycle

The server commands start, identify, inspect, and stop the OpenCode process used
by a DiffOwl review without touching another checkout's server.

## Sub-features

- `opencode-server-owned-lifecycle` proves start, health, version identity, and
  stop for one dedicated scratch port.

## Controller

Run `control-diffowl run opencode opencode-server-owned-lifecycle --json`, then
confirm `network-summary --run <run-id> --json` reports the port closed.

## How to get to it (user POV)

- Run `diffowl server start`, `status`, and `stop` from a configured repository.

## Driving it with the capture harness

Preconditions:

- The scratch config contains the reserved port from `receipt.txt`.
- No process listens on that port immediately before start.

- **Start.** Capture `node "$DIFFOWL_BIN" server start`. Record the created
  `.diffowl/server.pid` and inspect that exact PID's command.
- **Status.** Capture `node "$DIFFOWL_BIN" server status`. It reports the same
  port and serving version. Record the installed OpenCode CLI version separately
  and preserve any mismatch warning.
- **Stop.** Capture `node "$DIFFOWL_BIN" server stop`, then status again. The
  recorded PID is no longer live and the port no longer accepts health checks.
- **Restart case.** When version mismatch handling changed, restart only this
  owned process and prove the new serving identity.

## Gotchas

- `opencode --version` identifies a CLI binary, not the process serving a review.
- A model visible in one CLI catalog may be absent from a stale server catalog.
- Never use process-name kills. The recorded PID and reserved port are the
  authority boundary.
