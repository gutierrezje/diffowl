# Evidence for DiffOwl verification

Use this contract with the selected surface and feature recipe. Commands below
use `control-diffowl` as shorthand for `skills/verify-diffowl/control-diffowl`
from the source checkout.

## Select the claim

State the changed behavior, triggering input, and observable outcome before
running it. Separate required acceptance from optional confidence checks. Pick
the smallest journey that reaches the change; version/help and an empty database
are smoke checks, not coverage for a changed review or populated-state journey.

Use related task decisions when they settle a concrete scope or environment
question. Preserve the requested backend: Codex and OpenCode are distinct
verification surfaces. A blocked provider leaves that claim unverified; switching
providers can supply separate evidence but cannot satisfy it.

Reuse prior evidence when source, artifact, runtime, fixture, and relevant
behavior still match. After repairs, rerun the affected journey against the final
build. Record why untouched evidence remains applicable instead of repeating
every passing check. These skills verify behavior; they do not start a new PR
review cycle or grant publication authority.

## Bind the run

`new-run` builds the checkout and creates a disposable repository. Use
`<surface> doctor --run <run-id> --json` after creation and again after the
journey, before cleanup. Run-bound checks compare the recorded source and binary;
a checkout-only doctor is a readiness probe. If identity changed during the run,
retain the evidence and create a fresh run after the changes settle.

Keep the source revision and dirty-state identity separate from the scratch's
review target. Record the exact staged diff, commit, or base range being tested.
When target selection changes, include an unrelated change outside that target
so the expected inclusion and exclusion can both be observed.

The controller's Git snapshots cover status and tracked/index diffs, not the
contents of existing untracked or ignored files. For repository-guard changes,
seed and hash representative files in those classes before the turn and after
child close. Its database summaries are counts and hashes; verify changed row
semantics with focused read-only queries or a second CLI read. Inspect exact
resolved commit IDs as well as target kind when claiming target correctness.

## Automated and manual coverage

`capabilities` lists mapped feature IDs, including recipe-driven features. It
does not promise an executable driver for every row. Inspect the receipt's
observations and confounds. `success: true`, a dry run, or a snapshot alone is not
a feature verdict.

For a recipe-driven feature or a changed behavior beyond an existing driver's
assertions:

1. Create the appropriate mapped run and drive the recipe in its scratch through
   the built binary, using a PTY for interactive behavior. For an unmapped case,
   use the closest surface's mapped run only for setup and name the actual claim
   separately; do not invent an accepted controller feature ID.
2. Capture commands, output, exits, and before/after state under its evidence
   directory. Use fresh labels for every attempt. The existing helper is a
   manual fallback: `helpers/capture.sh <evidence-dir> <unique-label> <scratch>
   -- <command> [args...]`, relative to `skills/verify-diffowl/`. It returns the
   command's exit status, including expected failures. A PTY transcript supplies
   equivalent evidence for interactive work.
3. Inspect the actual outcome and retain a separate `assessment.json` beside the
   controller receipt. Record the run ID, claim, live or simulated execution,
   expected and observed result, artifact paths, verdict, gaps, and cleanup.
   Leave the controller receipt unchanged: `snapshot` adds evidence and `receipt`
   reads it; neither assesses manual work nor promotes `INCONCLUSIVE` to VERIFIED.

Manual launches are not automatically registered as controller-owned processes.
Record their PID, launch identity, and scratch; close them through their owning
terminal or harness and verify exit before removing the scratch. Controller
`cancel` and cleanup only cover processes they recorded.
`wait-settle` also requires a terminal controller run; it cannot finalize a
manually driven run that is still recorded as `created`. Observe manual process
exit and durable outcomes directly. A stopped capture wrapper alone does not
prove all provider descendants exited.

## Decide and retain

- **VERIFIED:** the selected claim has matching target identity, the expected
  behavior and resulting state, and completed teardown.
- **NOT VERIFIED:** the correct journey ran and contradicted its expected result.
- **INCONCLUSIVE:** the relevant branch was not reached or evidence is missing,
  stale, or blocked. Identify whether the cause is product, fixture, harness, or
  environment; an unsupported driver is not a product defect.

Report separate verdicts when proof differs. Mock-child failures can prove retry
or policy behavior; they do not establish live provider compatibility. A live
success does not cover an unobserved failure branch. Cancellation that loses the
race to normal completion is inconclusive for interruption.

Preserve failed attempts and the first causal error. Retry after a named repair
or prerequisite change; keep the new attempt distinct. Follow progress and
terminal state rather than fixed sleeps. A queue or hook is complete only when
the exact triggering commit has a terminal outcome and its owned worker settles.

Before cleanup, copy any manual logs, reports, hook files, and required database
evidence out of the scratch; use a consistent SQLite backup if writers remain.
Confirm retained paths remain readable after cleanup. Keep raw evidence local
by default and link a concise receipt; committing bulky evidence is a separate
publishing decision.
