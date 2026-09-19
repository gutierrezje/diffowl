# Readiness query

Use this recipe for coverage, lineage, readiness output, or read-only query changes.
Create a CLI `findings-inspect` run for scratch setup and follow the shared manual
evidence contract. This journey has no dedicated controller feature ID.

1. In the recorded disposable repository, create a committed base and a separate
   feature commit. Run the built `readiness --base <base-sha> --format json` before
   any review. Retain the document, exit 1, and proof that no database was created.
2. Run a full branch review through the selected supported backend. Explicitly
   disposition any actionable findings, then query readiness for the same base
   and HEAD. Expect exit 0 with the published review as checkpoint.
3. Commit two repairs and review only the tip. Expect stale coverage naming the
   missing middle commit. Review that middle SHA while leaving the tip checked
   out; expect ready with checkpoint and repair IDs in order. Then publish a new
   full checkpoint, advance HEAD again, and confirm stale coverage names only
   the new gap rather than commits already covered by the newer checkpoint.
4. Exercise a local dirty file and a finding disposition. Confirm the reason and
   exit change without starting a provider call from the readiness command.
5. Read from a linked worktree at the same HEAD. Completed evidence is shared;
   pending hook markers in the original checkout do not belong to the other one.
6. Compare database, WAL, index, queue, and fixture bytes before and after repeated
   queries. Stable inputs must produce identical JSON. Preserve malformed-state
   attempts and verify exit 2 without migration, cleanup, or logging in the repo.

For schema upgrades, follow [durable state](durable-state.md) and retain old-schema
review/finding/lifecycle IDs across the explicit write. Separate synthetic
fixture evidence from live provider publication. Retain a manual assessment,
then clean only the controller-owned scratch.
