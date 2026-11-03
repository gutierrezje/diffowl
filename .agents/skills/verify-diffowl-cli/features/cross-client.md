# Cross-backend and native-client handoff

Use this manual recipe to check backend compatibility on one shared input, or to
check that a coding client follows the installed DiffOwl handoff instructions.
No controller feature ID covers it. Create a CLI `findings-inspect` run for
scratch setup and follow the shared manual evidence contract. The 2026-10-28
[verification record](../../../../docs/verification/cross-client-2026-10-28.md)
is a worked example.

## Freeze the comparison

Before any paid call, write a manifest with the source HEAD, `dist/cli.js` and
worker hashes, and the fixture's base, head, and diff hash. Add the expected
file, line, and behavior, and a reproducer that fails on the change and passes
on the base. Also record depth, timeout, reasoning, the model for each backend
or client, trials per lane, and the pass threshold. One trial is evidence of
compatibility, never of quality ranking.

Distinguish a human-readable patch digest from the CLI's runtime diff hash:
DiffOwl collects `--stat --patch`, and captured-command helpers may trim terminal
newlines. Preserve and hash the exact reviewed representation rather than
expecting differently formatted diffs to have identical hashes.

## Same change through each backend

1. Commit one small regression whose expected behavior is stated in the fixture.
   Seed tracked, untracked, and ignored sentinels, plus project Claude and Cursor
   hooks that would write a marker if ambient settings ran.
2. Copy the fixture into one lane per backend. Run the built binary's
   `review --base main --backend <backend> --model <model> --depth <depth>
   --format json --fail-on-findings` in each lane. Prerequisites differ: Codex
   needs ChatGPT login, Claude needs `claude auth status`, and Cursor needs an
   SDK login or `CURSOR_API_KEY`.
3. For each lane, record the review JSON, report, durable row, requested and
   effective model, session, usage, and timings, plus before and after sentinel
   hashes. Equal `context_manifest_sha256` values prove identical captured local
   context. Runtime instructions, tool capabilities, and model defaults can
   still differ.
4. Grade the expected location and behavior, persistence, and fixture safety.
   Blind backend labels when adjudicating findings; count duplicate claims and
   unsupported findings separately. Track owned process IDs while executing and
   verify their exit. Record any missing independent teardown observation.

## Native-client handoff

1. Repair the regression in a new commit and record the finding as fixed with
   `--verified-by`. Install the
   adapters from [Client adapters](../../../../docs/agent-handoff.md#client-adapters):
   the managed `AGENTS.md` block, a `CLAUDE.md` pointer, and an always-applied
   Cursor rule before the covering checkpoint review, since the instructions
   are part of the committed branch. Confirm the built `readiness` returns exit
   0 with result `ready`.
2. Copy the fixture into one lane per client and scenario. Scenario `ready` is
   the clean copy. Scenario `dirty` adds an unrelated untracked operator file.
   That file must survive, and the client must report `commit-or-restore` as a
   blocker.
3. Bind the command to the absolute built binary, for example by adding
   "For this fixture, diffowl means node /absolute/checkout/dist/cli.js" to the
   common task prompt. Inspect the client's actual command event. Login shells
   can reorder `PATH` and select an installed release with a different policy
   version; an outer-shell shim alone does not establish identity.
4. Before each run, retain the expected readiness JSON and exit status from the
   built binary. Also snapshot HEAD, `git status --ignored`, and every
   non-`.git` file hash, including `.diffowl/state.db`. Give all clients the
   same prompt, for example "Confirm whether this branch is ready for handoff. Do
   not modify files." Record additional binary/base or command-shape hints as
   assisted execution. Capture structured events and explicitly close stdin
   (`< /dev/null`, or the launcher's `stdin: "ignore"`):
   - `codex exec --ephemeral --json --sandbox workspace-write -C <lane> <prompt>`
   - `claude -p --output-format stream-json --verbose --no-session-persistence`,
     with read tools and a narrow Bash rule for the exact readiness command.
     Put `--` before the prompt after variadic options such as `--mcp-config`.
   - `cursor-agent -p --model <model> --output-format stream-json --trust --auto-review --sandbox enabled --workspace <lane> <prompt>`
   Use only execution modes authorized for the fixture. Preserve permission
   denials rather than force-allowing tools. Interactive `init` needs a real PTY;
   redirecting its output through `capture.sh` removes that terminal.
5. Grade the events and the final answer, never the client's self-report. Read
   the verdict from the first paragraph that states one; clients often open
   with a progress line.
   Require all of the following:
   - It ran readiness for the intended base with JSON output. Omitted `--base`
     is valid when the local default branch is intended and the returned OIDs
     agree. Grade the contract rather than the spelling of the flags.
   - It started no review or finding disposition, and ran no mutating command.
   - The attached JSON is deep-equal to the expected document.
   - The leading verdict matches. Outside the attached JSON, the answer states
     the sum of `blockers.open + regressed + deferred + untracked`. A dirty tree
     is a separate readiness reason and does not increase that finding total.
   - Before and after snapshots are identical, and repeated readiness is
     byte-stable.

## Client prerequisites and confounds

- `cursor-agent status` can print a login while `-p` reports "Authentication
  required". Probe print mode before a run. The CLI login (`cursor-agent login`)
  is separate from the SDK login used by the review backend, and it needs
  explicit user approval. If the login runs in the background, keep the process
  alive until the browser step finishes. The CLI's default model can hit an
  account quota, so pass an explicit model and record it.
- Record each client's effective global instructions, plugins, and any isolation
  overrides. A compound command can trip a Claude allowlist; count a
  denial as a harness confound only when the client recovers through allowed
  commands.
- Claude can wrap an expected exit-1 CLI document in a tool error envelope.
  Inspect the underlying command exit and JSON separately from the native
  client's process exit. A `commit-or-restore` result is expected evidence for
  the dirty scenario, not a failed client journey.
- Cursor Ask mode blocks shell commands. Test successful command execution in
  an authorized Agent mode with its sandbox enabled; retain Ask-mode denial as
  separate blocked-path evidence.
- Strict Codex read-only mode can block the private SQLite temp snapshot.
  Readiness must return exit 2 in that case. A successful path needs permitted
  temporary writes; preserve the snapshot and execution-policy protections.
  See the [handoff prerequisite](../../../../docs/agent-handoff.md).
- Inside a restricted sandbox, `init` can warn that it could not verify the Codex
  model. Repeat the check outside the sandbox before calling it a product defect.
- A headless CLI stands in for its editor or app. Label it as such, and keep
  editor rule loading as a separate gap until it is observed.

Retain manifests, assessments, events, snapshots, the harness, and superseded
attempts under the run's evidence directory. Mark a blocked lane INCONCLUSIVE
and name its prerequisite. A blocked lane is not a client failure.
