# DiffOwl

```text
,___,
(O,O)
/)_)
" "
```

Review agent-written code with a second model before it ships.

DiffOwl is a local code review CLI. It builds focused context from a Git diff, sends that context to a model through [OpenCode](https://opencode.ai/docs/server/), and records actionable findings in your repository.

It works with changes from any coding agent or human. You choose the model and provider through OpenCode. DiffOwl does not require an account, another API key, or a hosted DiffOwl service.

## Why DiffOwl

The agent that wrote a change should not be its only reviewer. Asking it to review its own work can repeat the same assumptions that produced the bug.

DiffOwl adds an independent pass between writing code and shipping it:

- Review the last commit, staged changes, a specific commit, or a whole branch.
- Use any model already connected to OpenCode, including local models.
- Give the reviewer bounded local context instead of dumping the entire repository into a prompt.
- Keep findings after the review ends, with stable IDs and lifecycle states.
- Reopen the review session when a finding needs more investigation.
- Run reviews automatically after commits without blocking them.

TypeScript reviews include changed AST symbols, related tests, file excerpts, and bounded call-flow context. Other languages still get diff-centered review with targeted repository exploration.

## How it works

1. DiffOwl reads the Git change you selected.
2. It filters files and assembles relevant local context.
3. A separate model reviews the change through a headless OpenCode session.
4. DiffOwl writes a Markdown report and persists findings in SQLite.
5. You inspect the findings, continue the review chat, or hand them to a coding agent for resolution.

The orchestration and state stay in your repository. Review context is sent to the provider you selected in OpenCode.

## Quick start

You need Node.js 22.14.0 or newer and an authenticated [OpenCode](https://opencode.ai/) provider.

```bash
npm install --global opencode-ai
opencode
```

Connect a provider in OpenCode, then install and initialize DiffOwl:

```bash
npm install --global diffowl
cd your-repository
diffowl init
```

`diffowl init` finds your available OpenCode models, lets you choose one, and writes `.diffowl.yml`.

Review the last commit:

```bash
diffowl
```

Or review work before committing:

```bash
git add -p
diffowl review --staged
```

The latest report is written to `.diffowl/reviews/latest.md`.

## Choose what to review

| Command                         | Reviews                                           |
| ------------------------------- | ------------------------------------------------- |
| `diffowl`                       | The last commit                                   |
| `diffowl review --staged`       | Staged changes                                    |
| `diffowl review --commit <ref>` | One commit                                        |
| `diffowl review --base`         | Committed branch changes since the default branch |
| `diffowl review --base <ref>`   | Committed branch changes since an explicit base   |

Useful review options:

```bash
# Faster review with less context
diffowl review --staged --depth shallow

# Use a different model once
diffowl review --staged --model openai/gpt-5.6-luna

# Emit a versioned JSON document for scripts
diffowl review --base --format json

# Exit 1 when actionable findings remain
diffowl review --base --fail-on-findings
```

Branch review uses the merge base through `HEAD`, matching the committed diff in a pull request. It does not include staged or unstaged changes.

## Work with findings

DiffOwl stores durable findings in `.diffowl/state.db`. A finding stays open until someone records what happened to it. A later model review that fails to mention it does not silently mark it fixed.

```bash
# List unresolved findings
diffowl findings

# Inspect a finding by ID, ID prefix, or latest:N
diffowl findings show fnd_abc

# Record the outcome
diffowl findings fix fnd_abc --note "Added a null guard." --verified-by "pnpm run test"
diffowl findings dismiss fnd_abc --reason "The caller already validates this value."
diffowl findings defer fnd_abc --reason "Blocked by an upstream change."
diffowl findings reopen fnd_abc --reason "The bug returned in a new path."
```

Use `--format json` with `findings list`, `show`, or `summary` when another tool needs the backlog.

To continue the conversation behind a review:

```bash
diffowl chat
diffowl chat .diffowl/reviews/review-<timestamp>.md
```

## Resolve findings with a coding agent

The optional `diffowl-resolve` skill lets a coding agent investigate findings instead of accepting the review at face value. It verifies each candidate against the current code, fixes confirmed problems, records dismissals or deferrals, and preserves the report history.

```bash
npx skills add gutierrezje/diffowl --skill diffowl-resolve
```

Restart or reload the agent, then ask:

```text
Resolve the latest DiffOwl review.
```

You can also ask it to investigate one finding, resolve every open review, or archive reports whose findings are fully handled.

## Run reviews automatically

Install the non-blocking post-commit hook:

```bash
diffowl hook install
```

The hook queues each commit, returns control to the terminal, and writes output to `.diffowl/hook.log`. Failed reviews remain pending and retry after a later commit.

```bash
diffowl hook status
diffowl hook uninstall
```

Claude Code users can also show the current finding summary when a session starts:

```bash
diffowl agent-hook install --client claude
```

## Configuration

Project review policy lives in `.diffowl.yml`. Model selection is personal and stays in the shared, gitignored `.diffowl/preferences.yml`.

```yaml
context:
  depth: default

reasoning:
  effort: auto

gate:
  fail_on_findings: false

timeout: 300
min_confidence: medium
skip_doc_only: false

include:
  - "src/**/*"

exclude:
  - "**/*.test.*"
  - "**/*.lock"
  - "**/dist/**"

rules:
  - "Flag hardcoded secrets."
  - "Check authorization at every write boundary."
```

Choose or change your model without editing project policy:

```bash
diffowl model
diffowl model provider/model
diffowl model --reset
```

Configuration is deep-merged with defaults, so the file only needs the settings your repository changes.

## Files DiffOwl creates

```text
.diffowl.yml                                  # Committed project policy
.diffowl/preferences.yml                      # Gitignored personal model choice
.diffowl/state.db                             # Authoritative findings backlog
.diffowl/reviews/review-<timestamp>.md        # Immutable review snapshot
.diffowl/reviews/latest.md                    # Copy of the newest report
.diffowl/reviews/resolved/                    # Reports archived by the resolution skill
```

Linked Git worktrees share the durable backlog and review reports from the primary checkout. Runtime files such as hook logs and server state remain checkout-specific.

## Command reference

| Command              | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `diffowl init`       | Configure DiffOwl in the current repository |
| `diffowl review`     | Run a review                                |
| `diffowl model`      | View or change the selected model           |
| `diffowl findings`   | Inspect and update durable findings         |
| `diffowl chat`       | Reopen an OpenCode review session           |
| `diffowl hook`       | Manage the post-commit hook                 |
| `diffowl agent-hook` | Manage supported agent client hooks         |
| `diffowl server`     | Manage the local OpenCode server            |

Run `diffowl <command> --help` for every option.

## Troubleshooting

- No models found: run `opencode`, connect or re-authenticate a provider, then rerun `diffowl init`.
- Review timed out: retry with `diffowl review --depth shallow`.
- Hook review failed: run the retry command shown by the next foreground DiffOwl command, or inspect `.diffowl/hook.log`.
- Agent did not load `diffowl-resolve`: verify it with `npx skills list`, then restart or reload the agent.

## Develop locally

```bash
git clone https://github.com/gutierrezje/diffowl.git
cd diffowl
pnpm install
pnpm run build
pnpm link --global
```

Run the checks:

```bash
pnpm run lint
pnpm run test
```

After changing `src/**`, rebuild before testing the globally linked `diffowl` command.

## License

MIT © [Jesus Gutierrez](https://github.com/gutierrezje)
