# Findings inspection and disposition

Findings commands let a user read the durable backlog and record an explicit
outcome for a finding produced by a review.

## Sub-features

- `findings-inspect` lists, summarizes, and shows durable findings.
- `finding-disposition` records fix, dismissal, deferral, or reopen state through
  the CLI.
- `finding-duplicate-disposition` lists, shows, confirms, or rejects a possible
  duplicate link through the CLI.

## Controller

Run `control-diffowl run cli findings-inspect --json` for the empty backlog.
For a persistent disposition, create a run with the matching feature ID, preview
the action with `run ... --run <run-id> --dry-run`, then follow this recipe and
capture `snapshot` plus `receipt`.

## How to get to it (user POV)

- Run `diffowl findings list|summary|show --format json`.
- Run `diffowl findings fix|dismiss|defer|reopen <locator>` with the required
  reason, note, or verification evidence.
- Run `diffowl findings duplicates list|show|confirm|reject` for possible links.

## Driving it with the capture harness

Preconditions:

- The empty-backlog path needs only the configured scratch.
- A disposition path needs a finding created in this same disposable repo by a
  provider recipe. If no finding was produced, report that sub-feature
  `INCONCLUSIVE`; do not insert rows with internal helpers and call it user proof.

- **Empty inspection.** Capture `findings list --format json` and
  `findings summary --format json`. Both parse, report zero counts, and do not
  create a finding.
- **Show.** When a disposable finding exists, capture `findings show <id>
  --format json`; the returned stable ID and occurrence match the review output.
- **Disposition.** Run only the changed transition. Capture the mutation command,
  then confirm it from a second read-only `show` or `list` command.
- **Actor.** When an agent makes the decision, pass `--actor agent` where the
  command supports it. The durable event must not claim the human made it.

## Gotchas

- A later review omitting a finding does not resolve it; only a lifecycle event
  does.
- Locator prefixes can be ambiguous. Ambiguity must fail rather than mutate an
  arbitrary finding.
- Persistence proof requires a second read. The mutation's success line alone is
  insufficient.
