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
3. Commit a repair. Expect stale coverage, then review that exact commit and
   query again. The coverage chain must name the checkpoint and repair IDs in
   order. A missing intermediate repair remains not ready.
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
