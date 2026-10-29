# DiffOwl

```text
,___,
(O,O)
/)_)
" "
```

DiffOwl is an independent reviewer for agent-written code. It reviews a Git change with the model you choose, stores each finding in your repository, and remembers what you decided about it.

DiffOwl is a command-line tool. It reviews changes from any coding agent or person, works with any Git remote, and needs no DiffOwl account.

## What DiffOwl is good for

### A second reviewer that the author doesn't control

The agent that wrote a change should not be its only reviewer. When you ask it to check its own work, it brings the same assumptions that produced the bug.

DiffOwl starts every review from a clean prompt and context that it builds itself from the diff. The review runs through a backend you already use: OpenCode, the Codex CLI, the Claude Code CLI, or the Cursor SDK. The reviewer can be the same model that wrote the code. What makes the review independent is the fresh context, not different model weights.

### Findings that remember what you decided

A review comment is easy to lose. A DiffOwl finding is a record in `.diffowl/state.db` with a stable ID that starts with `fnd_`. DiffOwl recognizes a finding again when a later review quotes the same code in the same file. The finding stays open until someone records an outcome:

- Dismiss a finding with a reason, and it stays dismissed when later reviews flag the same code.
- Mark a finding fixed, and DiffOwl requires the command that verified the fix. If a later review flags the same code again, the finding reopens as `regressed`.
- A later review that does not mention a finding leaves it open. Silence from the model is not a fix.

Repeated reviews stay readable. Each report labels a finding as new, existing, or regressed, and hides the findings you dismissed or deferred.

### Proof that a branch is ready to hand off

`diffowl readiness` answers one question: was every commit on this branch reviewed, and was every finding fixed or dismissed? It does not start a review or change anything. Agents can query it before they declare work done, and scripts can read its exit code.

### No service in the middle

The review loop and its state live in your checkout. Reports and findings are files that you and your agents read directly. DiffOwl sends the review context to the backend and model you selected, so your code goes wherever that provider runs.

### What DiffOwl does not do

- It does not post pull-request comments or replace a hosted review platform.
- It does not change your code. The optional `diffowl-resolve` skill lets a coding agent fix findings, and that agent records each outcome.
- It does not claim to find more bugs than the same model would find with the diff alone. DiffOwl's value is the workflow around the review.
- TypeScript changes get extra structured context: changed symbols, related tests, and import references. Other languages get a diff-centered review, and the reviewer can explore the repository with read-only tools.

## Run your first review

This walkthrough uses OpenCode, the default backend. To use Codex, Claude Code, or Cursor instead, follow [Set up a review backend](docs/how-to.md#set-up-a-review-backend) and then continue from step 2.

You need Node.js 22.14.0 or newer and a Git repository with at least one commit.

1. Install OpenCode and start it:

   ```bash
   npm install --global opencode-ai
   opencode
   ```

   In OpenCode, connect a model provider, then exit.

2. Install DiffOwl:

   ```bash
   npm install --global diffowl
   ```

3. Set up DiffOwl in your repository:

   ```bash
   cd your-repository
   diffowl init
   ```

   DiffOwl prints the selected backend, lists the models from your connected providers, and asks you to pick one. It saves your model choice in the gitignored `.diffowl/preferences.yml`. It writes review policy to `.diffowl.yml`, which you can commit. It then offers to add DiffOwl instructions to `AGENTS.md` and to install hooks.

4. Review the last commit:

   ```bash
   diffowl
   ```

   When the review finishes, DiffOwl prints a count of errors, warnings, and suggestions, and the path of the new report file, such as `.diffowl/reviews/review-<timestamp>-<id>.md`. If the model finds nothing, DiffOwl prints `No issues found.` That is a valid result.

   If the commit changes only files that `.diffowl.yml` excludes, DiffOwl prints `No changes to review` and writes no report. Make a commit that changes a source file, then run `diffowl` again.

5. List the open findings:

   ```bash
   diffowl findings
   ```

   If the list is empty, the review found nothing to record, and you are done.

6. Record what happened to one of them. Replace `fnd_abc` with an ID, or a unique ID prefix, from the list:

   ```bash
   diffowl findings dismiss fnd_abc --reason "The caller already validates this value."
   ```

   The finding leaves the open list. If a later review flags the same code, the finding stays dismissed.

When you fix a finding instead, record the fix with the command that proves it:

```bash
diffowl findings fix fnd_abc --note "Added a null guard." --verified-by "pnpm run test"
```

## Next steps

- [Review a branch before you open a pull request](docs/how-to.md#review-a-branch-before-you-open-a-pull-request)
- [Review every commit automatically](docs/how-to.md#review-every-commit-automatically)
- [Have a coding agent resolve findings](docs/how-to.md#have-a-coding-agent-resolve-findings)
- [Check that a branch is ready for handoff](docs/how-to.md#check-that-a-branch-is-ready-for-handoff)
- [Use DiffOwl in scripts and CI](docs/how-to.md#use-diffowl-in-scripts-and-ci)
- [Command, configuration, and file reference](docs/reference.md)
- [Agent handoff workflow](docs/agent-handoff.md) and [readiness contract](docs/readiness-contract.md)

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) to set up a development checkout and open a pull request.

## License

MIT © [Jesus Gutierrez](https://github.com/gutierrezje)
