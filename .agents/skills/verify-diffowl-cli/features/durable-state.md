# Durable state, upgrades, and worktrees

Use this recipe when a change affects persisted operations, executions,
retention, migration, or shared worktree state. Fresh empty-database inspection
does not reach these behaviors.

## Controller boundary

These cases have no dedicated automated feature IDs. Create a CLI
`findings-inspect` run for isolated setup, then follow the shared manual evidence
path. Name the actual acceptance claim in the assessment; the empty-backlog
driver's verdict does not cover it. Discover the affected command from current
`--help` and use the freshly built binary.

## Schema release gate

Before accepting a schema change, apply the
[database schema release gate](../../../../CONTRIBUTING.md#database-schema-release-gate).
Confirm the latest published package/tag and its recorded schema boundary. Reuse
the one unreleased migration; do not allocate another number for a feature PR.
Run `pnpm exec vitest run src/state/migrations/released-migrations.test.ts` and
record the released version, proposed version, and result in the assessment.
A release without schema changes requires no new migration.

Verify fresh creation and upgrades from the latest released schema through the
whole unreleased migration. Same-number development databases with different SQL
must still be rejected by the checksum guard. Existing user state requires an
explicit backup/recovery decision; this recipe does not authorize resetting it.

## Select the changed branch

- **Retention or reconciliation.** Seed the relevant mix of disposable records,
  including a protected record and records on either side of the changed limit.
  Trigger the real public command that writes or prunes state. Query retained
  IDs, operation/execution links, outcomes, and findings afterward. Count alone
  cannot prove that the right records survived. Use focused real-SQLite tests
  for transactional rollback or injected faults, and label that evidence apart
  from the built CLI run.
- **Upgrade.** Identify whether the input schema came from a released client or
  an unreleased development build. Use a disposable historical fixture for the
  supported path and record its schema and representative linked rows before
  opening it with the new binary. Verify expected schema, preserved history,
  foreign keys, and integrity after migration. When future-schema rejection
  changes, verify its diagnostic and absence of mutation. An abandoned dogfood
  schema is not automatically a supported upgrade path.
- **Worktree state.** Create a linked worktree inside the disposable setup.
  Exercise the changed write from one worktree and read from the other. Check
  the expected shared preferences or database root, plus isolation of unrelated
  targets. A single-checkout run cannot establish this behavior.

Prepare fixtures through existing supported paths where practical. If direct
database seeding is needed, identify it as fixture setup, preserve its inputs,
and exercise the changed behavior through the public command. Synthetic rows
cannot prove provider ingestion. Derive tables and columns from the current
schema instead of embedding another schema copy in this recipe.

For terminal failure persistence, retain stdout/stderr and exit status, then
query the operation and execution for this target. Assert the intended failure
classification and absence of a success report or unintended finding changes.
A deterministic local failure may prove persistence without spending provider
usage; it does not prove authentication, transport, or model behavior.

Retain database evidence before cleanup, and include both the supported path
tested and any intentionally unsupported case in the assessment. Existing user
databases are not disposable fixtures; this recipe does not authorize repairing
them.
