---
name: verify-diffowl
description: "Route DiffOwl verification to the project-local CLI, OpenCode, or Codex skill. Use only as a compatibility entry point when a request names verify-diffowl without selecting the changed surface."
---

# Verify DiffOwl

Select by the behavior changed. Read every selected skill and only its matching
feature recipes:

- [verify-diffowl-cli](../../.agents/skills/verify-diffowl-cli/SKILL.md) for
  configuration, preferences, hooks, findings, worktree state, and ordinary CLI
  output.
- [verify-diffowl-opencode](../../.agents/skills/verify-diffowl-opencode/SKILL.md)
  for the OpenCode server and review path.
- [verify-diffowl-codex](../../.agents/skills/verify-diffowl-codex/SKILL.md) for
  the Codex App Server review path.

Shared review-pipeline or capability-routing changes normally require both
provider skills. A changed CLI flag does not require a paid review merely because
the command is named `review`; use the lightest surface that reaches the changed
behavior.

All three skills use `skills/verify-diffowl/control-diffowl`. Discover its small
interface with `--help` and the selected surface's `capabilities --json`. Use the
documented capture fallback only when a recipe needs manual driving.

The selected skill loads the shared [evidence contract](references/evidence.md).
It covers evidence reuse, run identity, manual recipes, verdicts, and cleanup.

Before declaring the implementation complete, follow the installed DiffOwl
section of AGENTS.md (the shared
[agent handoff workflow](https://github.com/gutierrezje/diffowl/blob/main/docs/agent-handoff.md)) against the implementation
checkout. A disposable verification fixture proves a behavior, not readiness of
the implementation branch. Return its current readiness JSON proof or an explicit
blocker alongside the verification evidence.
