# Codex execution contract

Use this journey when a change affects model capabilities, App Server policy,
structured-output retries, or durable failure outcomes. A normal successful
review does not exercise these branches.

## Sub-features

- `codex-capability-routing` proves DiffOwl uses the selected model's advertised
  options and forwards the native value it records.
- `codex-policy-contract` proves read-only, no-network, and no-approval policy at
  both thread and turn scope.
- `codex-validation-failure` proves bounded whole-document retries and one honest
  terminal failure outcome.

## Controller

Create a run with `control-diffowl codex new-run <feature-id> --model <id>`, use
the focused mock-child recipe below, then capture `snapshot` and `receipt`. A
normal live success is only the final bracket where the recipe calls for it.

## Driving it

Start with one disposable target and the existing public Codex runner seam. Use
the real App Server for the smallest successful path. Use the repository's real
mock child only for policy violations and malformed output that a healthy live
provider should not produce.

- **Capabilities.** Read the selected model's current App Server metadata. Test
  one supported native option and the default or absent case. Capture what
  DiffOwl requested, what it sent to `turn/start`, and what it persisted. A stale
  or unsupported saved value must follow the changed contract with a visible
  diagnostic. Do not silently map it to a nearby effort name.
- **Policy.** Capture the effective thread and turn policy. Inject one unexpected
  server request or file-changing event through the mock child. DiffOwl fails
  closed, sends no permissive response, leaves the repository unchanged, and
  closes the child.
- **Validation.** Inject malformed complete documents through the same output
  mode the patch changed. Confirm the configured attempt limit, ordered turn IDs
  when exposed, and final validation classification. One malformed finding
  rejects the whole document.
- **Failure persistence.** Inspect JSON and SQLite after the injected failure.
  The operation records the exact target and terminal failure without a false
  success report or reconciled findings. If failure persistence is not part of
  the current product contract, state that boundary instead of expecting rows
  the product cannot create.
- **Live bracket.** Finish with one real successful review only when the changed
  capability or protocol needs provider confirmation. Record actual attempts and
  usage. Do not repeat paid runs to manufacture a preferred review answer.

## Verdict

Return one result per selected sub-feature. Use `INCONCLUSIVE` when the public
evidence cannot establish child auth, effective policy, the value sent to the
provider, retry count, or terminal persistence. Passing unit tests plus an
ordinary live success cannot verify an unobserved failure branch.
