# DiffOwl how-to guides

These guides assume DiffOwl is installed and `diffowl init` has run in your repository. To start from nothing, follow [Run your first review](../README.md#run-your-first-review). For every flag and setting, see the [reference](reference.md).

## Set up a review backend

DiffOwl uses OpenCode unless you select another backend. The backend and model choice stay in the gitignored `.diffowl/preferences.yml`, so each person picks their own. To select a backend before you run `diffowl init`, run `diffowl backend <name>` first.

### OpenCode

1. Install OpenCode and connect a model provider:

   ```bash
   npm install --global opencode-ai
   opencode
   ```

2. Select OpenCode and pick a model from your connected providers:

   ```bash
   diffowl backend opencode
   diffowl init
   ```

OpenCode model IDs have the form `provider/model`. When a review needs the local OpenCode server and the server is not running, DiffOwl starts it. To manage the server yourself, set `server.auto_start: false` in `.diffowl.yml` and use `diffowl server start`, `diffowl server status`, and `diffowl server stop`.

### Codex

Codex reviews use the local Codex CLI and its existing ChatGPT sign-in.

```bash
codex
diffowl backend codex
diffowl model gpt-5-codex
```

Run `codex` once to sign in, then exit. Codex model IDs are bare IDs, without a provider prefix.

### Claude Code

Claude Code reviews use the installed Claude CLI and its local authentication. DiffOwl has no separate Claude sign-in command.

```bash
claude auth login
diffowl backend claude
diffowl model sonnet
```

The model can be an alias such as `sonnet` or a full model ID. See the [Claude adapter notes](../src/claude/README.md) for its runtime and tool policy.

### Cursor

Cursor reviews use the official Cursor SDK. The SDK needs its own sign-in. It does not reuse a Cursor CLI login.

```bash
diffowl cursor login
diffowl cursor models
diffowl backend cursor
diffowl model composer-2.5
```

Pick the model ID from the list that `diffowl cursor models` prints for your account. `diffowl cursor login` creates a named API key that expires, and stores it in Cursor's credential store. To use an existing key instead, set `CURSOR_API_KEY`. Cursor bills usage to your Cursor account. To check the sign-in state without showing credentials, run `diffowl cursor status`.

The Cursor backend does not support reasoning overrides yet. If you saved one, clear it:

```bash
diffowl backend cursor
diffowl reasoning --reset
```

If `.diffowl.yml` still has a deprecated `reasoning` block, delete that block too. `diffowl reasoning --reset` changes only your local preferences, not project policy.

## Review the right change

| To review                              | Run                             |
| -------------------------------------- | ------------------------------- |
| The last commit                        | `diffowl`                       |
| Staged changes, before you commit      | `diffowl review --staged`       |
| One specific commit                    | `diffowl review --commit <ref>` |
| A branch, against the default branch   | `diffowl review --base`         |
| A branch, against a base that you name | `diffowl review --base <ref>`   |

To review only part of your work before you commit, stage it first:

```bash
git add -p
diffowl review --staged
```

To try another model or backend for one review without changing your saved choice, pass `--model` and `--backend`:

```bash
diffowl review --staged --backend claude --model sonnet
```

If a review times out, retry with less context:

```bash
diffowl review --staged --depth shallow
```

## Review a branch before you open a pull request

Run a branch review. It covers the same committed changes as the pull request:

```bash
diffowl review --base main
```

Branch review compares the merge base with `HEAD`. It does not include staged or unstaged changes, so commit your work first. To confirm that the branch is ready afterward, see [Check that a branch is ready for handoff](#check-that-a-branch-is-ready-for-handoff).

## Record what happened to a finding

1. List the open findings:

   ```bash
   diffowl findings
   ```

2. Read one finding in full. You can name it by ID, by a unique ID prefix, or as `latest:N`:

   ```bash
   diffowl findings show fnd_abc
   ```

3. Record the outcome:

   ```bash
   diffowl findings fix fnd_abc --note "Added a null guard." --verified-by "pnpm run test"
   diffowl findings dismiss fnd_abc --reason "The caller already validates this value."
   diffowl findings defer fnd_abc --reason "Blocked by an upstream change."
   diffowl findings reopen fnd_abc --reason "The bug returned in a new path."
   ```

`fix` requires at least one `--verified-by` command. Recording an outcome does not run a review. To get new model analysis, run `diffowl review` again.

## Have a coding agent resolve findings

The optional `diffowl-resolve` skill lets a coding agent check each finding against the current code instead of trusting the review. The agent fixes confirmed problems, records dismissals and deferrals, and keeps the report history.

1. Install the skill:

   ```bash
   npx skills add gutierrezje/diffowl --skill diffowl-resolve
   ```

2. Restart or reload your agent.

3. Ask the agent:

   ```text
   Resolve the latest DiffOwl review.
   ```

You can also ask it to investigate one finding, resolve every open review, or archive reports whose findings are all handled.

If the agent does not load the skill, run `npx skills list` to confirm that it is installed, then restart the agent.

## Review every commit automatically

Install the post-commit hook:

```bash
diffowl hook install
```

The hook queues each commit and returns control to your terminal at once. Review output goes to `.diffowl/hook.log`. If a hook review fails, it stays pending and runs again after a later commit. The next foreground DiffOwl command also prints a retry command.

To check or remove the hook:

```bash
diffowl hook status
diffowl hook uninstall
```

If your repository uses Husky, the first install adds a portable bridge to the tracked `.husky/post-commit` file. Commit that bridge if every contributor should run DiffOwl. The paths to Node and DiffOwl on your machine stay in local Git hook state, so later installs and upgrades do not change the tracked file. A linked worktree without its own launcher uses the one from the main checkout. Uninstalling in a linked worktree removes only that worktree's launcher.

To show the open finding summary when a Claude Code session starts, install the agent hook:

```bash
diffowl agent-hook install --client claude
```

## Check that a branch is ready for handoff

Run the readiness query against the base branch:

```bash
diffowl readiness --base main
```

The branch is ready when three things are true. A full branch review and any later repair reviews cover every committed change. The worktree is clean. No blocking finding is left. Fixed and dismissed findings do not block. Open, deferred, and regressed findings do.

If the result is not ready, follow the next action that it prints, then run the query again. Readiness never starts a review and never changes repository state.

Agents use the JSON form and follow its `next_action` field:

```bash
diffowl readiness --base main --format json
```

The [agent handoff workflow](agent-handoff.md) has the full loop and adapters for Codex, Claude Code, Cursor, and other agents. `diffowl init` can add the same instructions to `AGENTS.md`. The [readiness contract](readiness-contract.md) defines the policy and its limits.

## Use DiffOwl in scripts and CI

To read a review from a script, ask for the versioned JSON document:

```bash
diffowl review --base --format json
```

To fail a script when actionable findings remain, add `--fail-on-findings`. The command exits with code 1 in that case:

```bash
diffowl review --base --fail-on-findings
```

To make that the default for the repository, set `gate.fail_on_findings: true` in `.diffowl.yml`.

To read the finding backlog, use `--format json` with `diffowl findings list`, `diffowl findings show`, or `diffowl findings summary`.

## Fix common problems

- **No models found.** Run `opencode`, connect or re-authenticate a provider, then run `diffowl init` again.
- **Codex runtime missing.** Install the Codex CLI and make sure `codex` is on your `PATH`.
- **Codex authentication missing.** Run `codex` and sign in with ChatGPT.
- **Review timed out.** Retry with `--depth shallow`, or raise `timeout` in `.diffowl.yml`.
- **Hook review failed.** Run the retry command that the next foreground DiffOwl command prints, or read `.diffowl/hook.log`.
- **Agent did not load `diffowl-resolve`.** Run `npx skills list` to confirm that the skill is installed, then restart or reload the agent.
