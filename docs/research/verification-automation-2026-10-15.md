# Testing the verifier before trusting its automation

Research and experiment — 2026-10-15

## Decision

Strengthen the existing public verification controller instead of adding another
framework or relying on agents to remember a checklist. `new-run` records source,
binary, and controller identity. Previously, only the optional `doctor` command
compared that identity with the checkout. `run` could report `VERIFIED` using
stale evidence. The controller now checks identity before feature actions and
again before accepting a verdict, and refuses source changes during its build.

Keep the existing provider-free CI lane, add deliberate negative controls, and
retain failed-run evidence for seven days. This establishes a bounded local
contract; it does not establish Claude, Codex, or OpenCode release readiness.

## Research that informed the experiment

The recent Spill automation thread emphasized testing verification instructions
with deliberate defects and known-good controls. Its related Jstack experiment
also preserved a rejected candidate: better script-check scores did not excuse a
lost guard. The useful lesson here is to measure observable behavior and retain
failed attempts, rather than equate more instructions with stronger verification.

Anthropic recommends grading the environment's final state, isolating trials,
and using deterministic graders where possible. Balanced cases and a known-good
reference help distinguish a product defect from a broken grader. For DiffOwl,
the oracle should include the receipt, exit code, executed actions, and resulting
state. [Anthropic, “Demystifying evals for AI agents”](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

Mutation testing asks whether checks detect deliberately introduced faults;
passing a clean baseline alone cannot answer that question. We applied that idea
to stale identity evidence, using behavior-neutral mutations so the CLI itself
could still succeed. [Google, “State of Mutation Testing at Google”](https://research.google/pubs/state-of-mutation-testing-at-google/)

Lauren Tan's verification-skill guidance drives the real command surface and
records command, output, exit code, and side effects. We therefore exercised
`control-diffowl` directly rather than testing a mock identity comparator alone.
[pstack verification-skill instructions](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md)

GitHub's artifact action supports retaining failed workflow output with an
explicit retention period. The workflow pins its implementation by commit and
uploads the existing evidence directory only on failure; hidden files are not
included. [GitHub, upload-artifact](https://github.com/actions/upload-artifact)

## Paired experiment

The baseline was commit `89a6be422a023611f248cf879881dfebf467e460` in a
disposable checkout. The treatment was the first implementation candidate on
that base. Both used the same host, Node 26.4.0, feature (`cli-version-help`),
public commands, and freshly built CLI binary (Git blob
`f1bb3d6db47a24c8fd22c623e6c0e92207caa2dc`). No provider was invoked.

The six cases, expected outcomes, source hashes, and scoring rule were frozen
before the scored trials. Each arm ran once per valid case. Promotion required
both stable controls to pass and all four mutations to be rejected. `run` was
invoked without a preceding `doctor`; a later doctor result was retained only as
secondary evidence. Independent file hashes established that each mutation
actually occurred.

| Case                                                   | Baseline | First candidate |
| ------------------------------------------------------ | -------- | --------------- |
| Unchanged checkout during the run                      | VERIFIED | VERIFIED        |
| Unchanged extra source fixture present before creation | VERIFIED | VERIFIED        |
| Source fixture changed after creation                  | VERIFIED | INCONCLUSIVE    |
| Harmless binary comment added after creation           | VERIFIED | INCONCLUSIVE    |
| Controller wrapper comment added after creation        | VERIFIED | INCONCLUSIVE    |
| Source fixture changed after the real CLI help command | VERIFIED | INCONCLUSIVE    |

The baseline falsely accepted 4/4 stale-evidence cases. The candidate accepted
0/4 and preserved 2/2 successful controls. Preflight rejection executed no feature
actions; the during-run rejection retained all four action records. Rejections
returned a nonzero exit code and preserved diagnostics in the receipt.

The first during-run pair was excluded: macOS `/tmp` versus `/private/tmp`
canonicalization prevented the baseline shim from injecting its mutation.
Independent hashes exposed that fixture failure. A revised protocol used the
created manifest's exact binary path, then reran that pair in both arms; the five
already-valid pairs were retained. Diagnostic and excluded trials remain separate
from the scored results. The candidate checkout contained implementation changes,
so “unchanged” means stable during the trial, not an empty Git status.

## Repairs and regression coverage

Independent review then identified a build-boundary race: recording source only
after the build could associate changed source with an older binary. The final
implementation compares source before and after the build. It also frames source
fingerprint fields unambiguously and treats failed Git identity reads as errors.
The six-case comparison describes the first candidate, not a rerun of these later
repairs; focused regression tests cover the final behavior.

Run the maintained public-controller suite with:

```sh
pnpm run test:verification
```

It covers stable source, source/binary/controller drift, missing identity,
during-run mutation, build-time mutation, and fingerprint ambiguity alongside the
existing CLI journeys. Tests use disposable repositories and restore injected
files. Receipts and command output are kept under the ignored
`artifacts/verification/` directory. CI already ran this suite on Ubuntu with
Node 22.14; this change extends its checks and retains failed evidence.

## Limits and next steps

These single-run seeded cases measure only the named regression corpus, with no
population-reliability or performance claim. The local experiment used macOS and
Node 26.4.0; the hosted lane supplies separate Ubuntu/Node 22.14 evidence.

Source identity follows Git-visible status/diff and nonignored untracked content.
Ignored dependencies, files hidden by Git index flags, and inherited Git
repository-selection overrides are outside that scope.
Before/after snapshots do not detect a transient edit restored between checks
and are not an immutable build attestation. Stable dirty checkouts remain valid.

Provider compatibility, authentication, model quality, and the remaining Claude
and first-run setup issues require their own live checks and fixes before a
release. Extend this verifier only when another concrete failing control reveals
a missing assertion; preserve each failed attempt instead of replacing it with a
later successful receipt.
