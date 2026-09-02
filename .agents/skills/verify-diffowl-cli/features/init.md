# Interactive setup

Setup chooses a backend-specific model, writes project policy, and offers agent
and Git hook integration through a real terminal.

## Sub-features

- `init-codex-setup` completes setup without querying OpenCode providers.
- `init-agent-path` records the user's yes/no choices for agent instructions and
  hooks.

## Controller

Use `control-diffowl cli new-run <feature-id>` to create the target. Drive the
TTY journey below, then capture `snapshot --run <run-id>` and read the receipt.

## How to get to it (user POV)

- Run `diffowl init` in a repository from an interactive terminal.
- Answer the model and integration prompts.

## Driving it with the CLI-control harness

Preconditions:

- Use a fresh scratch. Remove its seeded `.diffowl.yml` and preferences only
  inside that scratch.
- Select Codex first with `diffowl backend codex` so the deterministic path asks
  for a bare model ID and does not need an OpenCode provider catalog.

- **Launch.** Start `node "$DIFFOWL_BIN" init` in an isolated tmux or PTY session
  rooted at the scratch. Capture the initial screen.
- **Model.** Wait for the Codex model prompt, enter `gpt-5.4`, and wait for the
  next named prompt before sending another answer.
- **Integrations.** Answer each yes/no prompt according to the feature under
  test. Capture the final screen and process exit.
- **State proof.** Inspect `.diffowl.yml`, `.diffowl/preferences.yml`, AGENTS.md,
  and hook files. Each selected integration exists once; skipped integrations
  are absent.

## Gotchas

- Piped stdin is not equivalent to an interactive TTY. Use the CLI-control
  harness.
- Wait for concrete prompt text instead of timing sleeps.
- Setup mutates several files. Run it only in the disposable repo and clean the
  entire scratch afterward.
