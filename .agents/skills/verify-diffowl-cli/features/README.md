# DiffOwl CLI verification map

Use `skills/verify-diffowl/control-diffowl cli capabilities --json` for the
executable inventory. Every feature uses a freshly built binary and one
disposable Git repository. The source checkout remains read-only.

## Entry-point coverage

| User entry point | Feature ID or disposition |
| --- | --- |
| `diffowl -V`, top-level and leaf `--help` | `cli-version-help` |
| Unknown commands and invalid option combinations | `cli-invalid-command` |
| Default `diffowl review` and `review --staged|--commit|--base` | Routed to the Codex or OpenCode map selected by `--backend` or preference |
| `diffowl init` model and project setup | `init-codex-setup`, `init-agent-path` |
| `diffowl backend|model|reasoning` view and set | `preference-select`, `preference-model-options`, `preference-preserve-policy` |
| `diffowl backend|model|reasoning --reset` | `preference-reset` |
| `diffowl hook install|status|uninstall` | `hook-install-status`, `hook-uninstall` |
| `diffowl agent-hook install --client claude` | `agent-hook-install-summary` |
| `diffowl server start|status|stop` | Routed to `opencode-server-owned-lifecycle` in the OpenCode map |
| `diffowl findings list|summary|show` | `findings-inspect` |
| `diffowl findings dismiss|defer|fix|reopen` | `finding-disposition` |
| `diffowl findings duplicates show|list|confirm|reject` | `finding-duplicate-disposition` |
| Hidden `hook-run` and `hook-worker` | Internal entries covered by `opencode-hook-review` |
| Hidden `eval` | Excluded: the eval harness has its own corpus and gate verification surface |

A newly discovered CLI command without a row is a coverage gap.

## Proof and cleanup

- `control-diffowl run cli <feature-id>` captures actions and before/after state.
- Use `--dry-run` for hook, finding, setup, or preference mutations.
- `control-diffowl cli receipt --run <run-id> --json` is the verdict source.
- Cleanup removes only the recorded scratch and retains evidence.

## Features

- [Version, help, and errors](version-and-errors.md): `cli-version-help`,
  `cli-invalid-command`.
- [Backend and model preferences](preferences.md): `preference-select`,
  `preference-model-options`, `preference-preserve-policy`, `preference-reset`.
- [Hook lifecycle](hook-lifecycle.md): `hook-install-status`, `hook-uninstall`,
  `agent-hook-install-summary`.
- [Findings](findings.md): `findings-inspect`, `finding-disposition`,
  `finding-duplicate-disposition`.
- [Interactive setup](init.md): `init-codex-setup`, `init-agent-path`.
