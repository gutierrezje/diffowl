# DiffOwl

```text
,___,
(O,O)
/)_)
" "
```

Review agent-written code with a second model before it ships.

DiffOwl is a local code review CLI. It builds focused context from a Git diff, runs a model through OpenCode or Codex, and records actionable findings in your repository.

It works with changes from any coding agent or human. You choose the backend and model on your machine. DiffOwl does not require a hosted DiffOwl account.

## Why DiffOwl

The agent that wrote a change should not be its only reviewer. Asking it to review its own work can repeat the same assumptions that produced the bug.

DiffOwl adds an independent pass between writing code and shipping it:

- Review the last commit, staged changes, a specific commit, or a whole branch.
- Review through OpenCode or a local Codex CLI authenticated with ChatGPT.
- Give the reviewer bounded local context instead of dumping the entire repository into a prompt.
- Keep findings after the review ends, with stable IDs and lifecycle states.
- Inspect and disposition durable findings after the review ends.
- Run reviews automatically after commits without blocking them.

TypeScript reviews can include changed AST symbols, related tests, file excerpts, and bounded import references. The structured import-reference section is TypeScript-only; non-TypeScript changes still get diff-centered review with targeted repository exploration.

## How it works

1. DiffOwl reads the Git change you selected.
2. It filters files and assembles relevant local context.
3. A separate model reviews the change through your selected local backend.
4. DiffOwl writes a Markdown report and persists findings in SQLite.
5. You inspect the findings, record their disposition, or hand them to a coding agent for resolution.

The orchestration and state stay in your repository. Review context goes only to the backend and model you selected.

## Quick start

You need Node.js 22.14.0 or newer. OpenCode is the default backend for existing installations.

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

`diffowl init` reports the selected runtime and the gitignored preference path. With OpenCode selected, it lists the models from your connected providers. Use `diffowl backend codex` before initialization if you want Codex, then choose a bare Codex model ID. The committed `.diffowl.yml` contains review policy, never your backend or model choice.

Codex reviews use an existing ChatGPT login from the local Codex CLI:

```bash
codex
diffowl backend codex
diffowl model gpt-5-codex
```

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

# Use Codex once without changing saved preferences
diffowl review --staged --backend codex --model gpt-5-codex

# Emit a versioned JSON document for scripts
diffowl review --base --format json

# Exit 1 when actionable findings remain
diffowl review --base --fail-on-findings
```

Commit review compares the selected commit with its first parent. For a merge commit, this means the changes the merge introduced to its first-parent branch. It is not the pull-request diff.

Branch review uses the merge base through `HEAD`, matching the committed diff in a pull request. Use `--base` for pull-request coverage. Neither mode includes staged or unstaged changes.

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

Inspect a finding with `diffowl findings show`, then record its disposition with `fix`, `dismiss`, `defer`, or `reopen`. Run a new review when you need new model analysis.

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

In a Husky repository, the first install adds a portable bridge to the tracked
`.husky/post-commit` file. Commit that bridge if the repository should run
DiffOwl for every contributor. Machine-specific Node and DiffOwl paths stay in
worktree-local Git hook state, so later installs and runtime upgrades do not
dirty the tracked Husky hook or interfere with another linked worktree.

```bash
diffowl hook status
diffowl hook uninstall
```

Claude Code users can also show the current finding summary when a session starts:

```bash
diffowl agent-hook install --client claude
```

## Configuration

Project review policy lives in `.diffowl.yml`. Backend, model, and model-specific reasoning choices stay in the shared, gitignored `.diffowl/preferences.yml`. Linked worktrees use the same preference file.

```yaml
context:
  depth: default

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

Inspect or change the local backend and its model without editing project policy:

```bash
diffowl backend
diffowl backend opencode
diffowl backend codex
diffowl backend --reset

diffowl model
diffowl model provider/model
diffowl model --reset

diffowl reasoning
diffowl reasoning thinking
diffowl reasoning --reset
```

Reasoning names are backend-native identifiers, not a shared DiffOwl scale. A model might advertise `low` and `high`, `thinking`, only one value, or no selectable value. An absent preference means the backend default; DiffOwl never translates one backend's names into another's. Changing a model clears its old reasoning preference so a stale value cannot carry over. Use `diffowl review --reasoning <variant>` for a one-review override.

When an explicit `max` selection is paired with a timeout of 300 seconds or less, DiffOwl warns before starting provider work. It does not lower the reasoning effort or extend the deadline automatically. Increase `timeout` in `.diffowl.yml` when a quality-first review should be allowed to run longer.

When model metadata rejects a variant, DiffOwl uses the backend default and
prints the model's advertised choices. If the model advertises no selectable
variants, the warning says so explicitly.

Each backend keeps its own model choice. Switching backends does not erase the other model. A legacy preference containing only `model: provider/model` still selects OpenCode. Legacy `.diffowl.yml` `reasoning.effort` values remain readable for migration and produce an exact cleanup warning; DiffOwl no longer writes them to project config.

Configuration is deep-merged with defaults, so the file only needs the settings your repository changes.

## Files DiffOwl creates

```text
.diffowl.yml                                  # Committed project policy
.diffowl/preferences.yml                      # Gitignored backend, model, and reasoning choices
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
| `diffowl backend`    | Inspect or change the local review backend  |
| `diffowl model`      | View or change the selected model           |
| `diffowl reasoning`  | View or change model-specific reasoning     |
| `diffowl findings`   | Inspect and update durable findings         |
| `diffowl hook`       | Manage the post-commit hook                 |
| `diffowl agent-hook` | Manage supported agent client hooks         |
| `diffowl server`     | Manage the local OpenCode server            |

Run `diffowl <command> --help` for every option.

## Troubleshooting

- No models found: run `opencode`, connect or re-authenticate a provider, then rerun `diffowl init`.
- Codex runtime missing: install the Codex CLI and make sure `codex` is on `PATH`.
- Codex authentication missing: run `codex` and sign in with ChatGPT.
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
