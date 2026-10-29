# DiffOwl reference

This page lists DiffOwl's commands, review options, finding states, configuration, and files. For step-by-step tasks, see the [how-to guides](how-to.md). Run `diffowl <command> --help` for the options of any command.

## Commands

| Command              | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `diffowl init`       | Configure DiffOwl in the current repository               |
| `diffowl review`     | Run a review. The default command when none is given      |
| `diffowl readiness`  | Check branch review coverage and findings without changes |
| `diffowl findings`   | Inspect and update durable findings                       |
| `diffowl backend`    | View or change the local review backend                   |
| `diffowl model`      | View or change the model for the selected backend         |
| `diffowl reasoning`  | View or change reasoning for the selected model           |
| `diffowl cursor`     | Sign in to the Cursor SDK and list its models             |
| `diffowl hook`       | Manage the post-commit hook                               |
| `diffowl agent-hook` | Manage agent client session hooks                         |
| `diffowl server`     | Manage the local OpenCode server                          |

## Review scopes

| Command                         | Diff that DiffOwl reviews                             |
| ------------------------------- | ----------------------------------------------------- |
| `diffowl`                       | The last commit against its first parent              |
| `diffowl review --staged`       | Staged changes against `HEAD`                         |
| `diffowl review --commit <ref>` | One commit against its first parent                   |
| `diffowl review --base`         | The merge base with the default branch through `HEAD` |
| `diffowl review --base <ref>`   | The merge base with `<ref>` through `HEAD`            |

Commit review compares a commit with its first parent. For a merge commit, the diff is the set of changes that the merge brought into its first-parent branch. That diff is not the pull-request diff.

Branch review matches the committed diff of a pull request. Commit review and branch review do not include staged or unstaged changes.

## Review options

| Option                  | Effect                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `--staged`              | Review staged changes                                         |
| `--commit <ref>`        | Review one commit                                             |
| `--base [ref]`          | Review committed branch changes since the merge base          |
| `--depth <depth>`       | Context depth: `shallow` or `default`                         |
| `--model <id>`          | Use this model for one review                                 |
| `--backend <backend>`   | Use `opencode`, `codex`, `cursor`, or `claude` for one review |
| `--reasoning <variant>` | Use this backend-native reasoning variant for one review      |
| `--format <format>`     | `text` or `json`. JSON output is a versioned document         |
| `--fail-on-findings`    | Exit with code 1 when actionable findings remain              |
| `--verbose`             | Include suppressed findings and extra review details          |

`--model`, `--backend`, and `--reasoning` do not change saved preferences.

## Review context

Every review gets the diff and bounded excerpts of the changed files. At the default depth, the reviewer can also read and search the repository through its backend's tools. See [Backend tool policies](#backend-tool-policies).

TypeScript reviews also get the changed AST symbols, related tests, and bounded import references. The structured import-reference section exists only for TypeScript.

The default depth keeps the complete diff. `--depth shallow` caps the diff at 12K characters and builds less context, so the review finishes sooner. Use it first when a review times out.

## Findings

### Identity

DiffOwl identifies a finding by its file and the code that the review quotes as evidence. A later review that quotes the same code in the same file matches the existing finding, so the finding keeps its ID and history. A finding without quoted evidence has no durable identity. DiffOwl shows it as untracked, and it cannot receive a disposition.

Finding IDs start with `fnd_`. Commands that take a finding accept the full ID, a unique ID prefix, or `latest:N`.

### States

| State       | Meaning                                       | Shown by `diffowl findings` | Blocks readiness |
| ----------- | --------------------------------------------- | --------------------------- | ---------------- |
| `open`      | Reported and not yet handled                  | Yes                         | Yes              |
| `regressed` | Marked fixed, then reported again             | Yes                         | Yes              |
| `deferred`  | Postponed with a reason                       | No                          | Yes              |
| `dismissed` | Rejected with a reason                        | No                          | No               |
| `fixed`     | Fixed, with at least one verification command | No                          | No               |

When a review reports a `dismissed` or `deferred` finding again, the finding keeps its state and DiffOwl hides it from the report. `--verbose` shows it. When a review reports a `fixed` finding again, the finding becomes `regressed`. A review that does not mention a finding does not change its state.

### Disposition commands

| Command                                                           | Result      |
| ----------------------------------------------------------------- | ----------- |
| `diffowl findings fix <id> --note <text> --verified-by <command>` | `fixed`     |
| `diffowl findings dismiss <id> --reason <text>`                   | `dismissed` |
| `diffowl findings defer <id> --reason <text>`                     | `deferred`  |
| `diffowl findings reopen <id> --reason <text>`                    | `open`      |

`--verified-by` can repeat. `fix` also accepts `--commit <ref>`. Every disposition command accepts `--actor user` or `--actor agent`, and prints JSON by default.

## Readiness

`diffowl readiness` checks the exact committed branch against a full review and any compatible, contiguous repair reviews. It does not start a review, change repository state, or migrate a database.

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | Ready                                                         |
| `1`       | Not ready                                                     |
| `2`       | Git, configuration, database, or runtime state cannot be read |

Dirty files and unhandled actionable findings block readiness. A later review does not resolve earlier findings. Reviews from versions without coverage evidence cannot prove readiness, so run a new full branch review. An older database needs a command that writes state before readiness can read it. Actionable output without a durable finding identity blocks readiness, because it cannot receive a disposition.

The JSON output includes the resolved base and `HEAD`, the review IDs that provide coverage, uncovered commits, blocker counts, and a `next_action`. `--depth` sets the expected context depth when it differs from project configuration. The [readiness contract](readiness-contract.md) defines the full policy.

## Project configuration

DiffOwl reads review policy from `.diffowl.yml` at the repository root. Commit this file. DiffOwl deep-merges it with the defaults, so the file needs only the settings that your repository changes.

| Key                                | Default    | Meaning                                                         |
| ---------------------------------- | ---------- | --------------------------------------------------------------- |
| `context.depth`                    | `default`  | Context depth: `shallow` or `default`                           |
| `timeout`                          | `300`      | Review deadline in seconds                                      |
| `min_confidence`                   | `medium`   | Lowest finding confidence to report: `low`, `medium`, or `high` |
| `include`                          | `["**/*"]` | Globs of files to review                                        |
| `exclude`                          | See below  | Globs of files to skip                                          |
| `rules`                            | `[]`       | Extra instructions for the reviewer                             |
| `skip_doc_only`                    | `false`    | Skip changes that touch only documentation                      |
| `verbose`                          | `false`    | Include suppressed findings and extra details                   |
| `gate.fail_on_findings`            | `false`    | Exit with code 1 when actionable findings remain                |
| `server.port`                      | `4096`     | Port of the local OpenCode server                               |
| `server.auto_start`                | `true`     | Start the OpenCode server when a review needs it                |
| `retention.hook_log_kb`            | `1024`     | Size limit of `.diffowl/hook.log` in KB                         |
| `retention.failed_execution_days`  | `14`       | Age limit for failed review executions                          |
| `retention.failed_execution_limit` | `200`      | Count limit for failed review executions                        |

The default `exclude` list is `**/*.test.*`, `**/*.spec.*`, `**/*.lock`, `**/node_modules/**`, `**/dist/**`, `**/build/**`, and `**/.git/**`.

DiffOwl treats `rules`, `include`, and `exclude` as trusted input and adds `rules` to the review prompt as written.

Example:

```yaml
context:
  depth: default

timeout: 300
min_confidence: medium

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

## Local preferences

The backend, model, and reasoning choices live in the gitignored `.diffowl/preferences.yml`, never in `.diffowl.yml`. Linked worktrees share one preference file. `diffowl init` prints its path.

| Command                       | Effect                                               |
| ----------------------------- | ---------------------------------------------------- |
| `diffowl backend`             | Print the selected backend                           |
| `diffowl backend <name>`      | Select `opencode`, `codex`, `cursor`, or `claude`    |
| `diffowl backend --reset`     | Return to the OpenCode default                       |
| `diffowl model`               | Print the model for the selected backend             |
| `diffowl model <id>`          | Set the model for the selected backend               |
| `diffowl model --reset`       | Remove the model preference for the selected backend |
| `diffowl reasoning`           | Print the reasoning variant for the selected model   |
| `diffowl reasoning <variant>` | Set the reasoning variant for the selected model     |
| `diffowl reasoning --reset`   | Use the backend default for the selected model       |

With no backend selected, DiffOwl uses OpenCode. Each backend keeps its own model choice, so a switch of backend does not erase the other backend's model. A legacy preference file that contains only `model: provider/model` selects OpenCode.

### Reasoning variants

Reasoning variants are backend-native names, not a shared DiffOwl scale. A model can offer `low` and `high`, `thinking`, one value, or none. DiffOwl never translates one backend's names into another's. With no preference saved, the backend default applies.

A change of model clears the old model's reasoning preference, so a stale value cannot carry over. When the model's metadata rejects a variant, DiffOwl uses the backend default and prints the variants that the model offers. If the model offers none, the warning says so.

When you select `max` explicitly and `timeout` is 300 seconds or less, DiffOwl prints a warning before the review starts. It does not lower the reasoning or extend the deadline. To give a slow review more time, raise `timeout` in `.diffowl.yml`.

DiffOwl still reads the deprecated `reasoning.effort` key in `.diffowl.yml` for migration and prints a warning that names the exact cleanup. DiffOwl no longer writes that key.

## Backend tool policies

The OpenCode backend allows only the read, grep, and glob tools at the default depth, and no tools at the shallow depth. DiffOwl rejects every OpenCode permission request.

The Codex backend starts each review in a read-only sandbox with approvals denied and network access turned off. The [Codex adapter notes](../src/codex/README.md) have the details.

The Cursor backend allows the read, search, glob, and directory-list tools. It turns off shell, MCP, subagents, and ambient project settings. If its repository guard sees a change during the review, DiffOwl rejects the review. This policy limits tools. It is not an operating-system sandbox, and it does not restrict which files the reviewer can read.

The [Claude adapter notes](../src/claude/README.md) describe the Claude Code backend's policy.

## Failed execution retention

DiffOwl removes old failed review attempts from each repository database after it saves a new attempt.

By default, cleanup removes `failed`, `cancelled`, and `timed-out` executions that nothing references and whose last update is older than 14 days. Cleanup then keeps the 200 most recently updated executions that are still eligible. Executions with equal timestamps are ordered by insertion. To turn off one limit, set it to `0`. To turn off cleanup, set both limits to `0`.

Cleanup never removes completed, running, or interrupted executions. It also keeps every execution that a review or another database record references, and those executions do not count toward the limit. Cleanup removes an operation only when the operation has no executions and no review. Cleanup never removes reviews, findings, observations, or lifecycle events, and it does not compact the database.

Cleanup runs in its own transaction after the attempt commits. If cleanup fails, DiffOwl rolls back the cleanup and keeps the attempt. The next saved attempt runs cleanup again.

The optional Node diagnostics channel `diffowl.state.retention` publishes `{ kind: "cleanup", databasePath, deletedExecutions, deletedOperations }` when cleanup removes rows. It publishes `{ kind: "cleanup-failed", databasePath, message }` when cleanup fails. These messages do not change command output or the JSON review document.

## Files DiffOwl creates

```text
.diffowl.yml                                  # Committed project policy
.diffowl/preferences.yml                      # Gitignored backend, model, and reasoning choices
.diffowl/state.db                             # Authoritative findings backlog
.diffowl/reviews/review-<timestamp>-<id>.md   # Immutable review snapshot
.diffowl/reviews/resolved/                    # Reports archived by the resolution skill
.diffowl/hook.log                             # Post-commit hook output
```

Each review writes a new report file. DiffOwl does not keep a `latest.md` copy.

Linked Git worktrees share the findings backlog and review reports of the primary checkout. Runtime files, such as hook logs and server state, belong to each checkout.
