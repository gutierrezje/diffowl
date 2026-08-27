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
