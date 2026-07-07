# DiffOwl Spike: pi Backend Experiment

**Status:** in progress (spike — most of this code is expected to be thrown away)
**Date:** 2026-07-07
**Type:** experiment — measures the pi coding agent SDK against OpenCode as
DiffOwl's review harness. Reopens decision 1 of plan 017 through the gate that
plan itself named: the eval harness now exists, so a backend can be measured
instead of adopted or rejected on faith.

## Hypothesis

An in-process pi SDK backend can match OpenCode's review quality while removing
DiffOwl's three most defensive subsystems — server lifecycle management
(`src/opencode/server.ts`), SSE settlement/reconciliation
(`src/opencode/settlement.ts`), and event normalization — and reducing flake
modes (settlement timeouts, marker fallbacks, permission races) that exist only
because the review runs against a UI-first server protocol.

Context that makes this worth measuring now:

- pi 0.80.x ships an SDK mode with `cwd`, tool allowlists, in-memory sessions,
  system-prompt override, and `abort()` — the exact surface a headless
  single-shot review needs.
- The provider-auth gap has narrowed: pi supports OAuth login for GitHub
  Copilot and ChatGPT subscriptions; Anthropic's April 2026 subscription-OAuth
  policy change hit OpenCode and pi equally.

## What was built (this branch)

| Piece | Files | Fate if pi loses |
| --- | --- | --- |
| pi review backend (contract-compatible with `runReview`) | `src/pi/backend.ts`, `src/pi/session.ts`, `src/pi/state.ts` + tests | deleted |
| Backend registry + selection (`--backend`, `DIFFOWL_BACKEND`) | `src/review/backend.ts` + test, `src/cli.ts` wiring | deleted or kept as a small seam |
| A/B experiment harness (`diffowl eval-backends`) | `src/eval/backend-experiment.ts`, `src/eval/backend-experiment-command.ts` + tests | possibly kept — useful for any future backend question |
| This design doc | `dev-docs/pi-backend-spike.md` (local pointer: plans/024) | updated with results either way |

Deliberate spike shortcuts (fix only if the spike graduates):

- `src/pi/backend.ts` imports prompts/parser/types from `src/opencode/client.ts`;
  shared review-contract pieces belong in `src/review/` if pi is adopted.
- Prompts, parser, and tool policy are shared across backends **by design** —
  the experiment isolates the harness variable. No pi-specific prompt tuning
  until after the baseline comparison.
- No usage-shape contract test against a live pi session (usage extraction is
  defensive; gaps show up as missing usage data, not failures).
- The `eval` command itself stays OpenCode-only; backend selection exists in
  `eval-backends` (comparison) and `review --backend` (dogfooding).

## Method

All comparisons hold model, prompts, corpus, trials, depth, and confidence
threshold constant; the backend is the only variable.

```bash
# Full corpus, both backends, 3 trials per case, pinned model:
pnpm run eval:backends -- --trials 3 --model <provider/model>

# Focused re-runs while iterating:
node dist/cli.js eval-backends --case fire-and-forget-async --trials 5 --model <provider/model>

# Manual dogfooding on real commits:
node dist/cli.js review --backend pi
DIFFOWL_BACKEND=pi git commit ...   # via hook
```

Prerequisite: pi must know the model — run `pi` once to log in / add an API
key (`~/.pi/agent/auth.json`), or register custom models in
`~/.pi/agent/models.json`. OpenCode auth stays as today.

Outputs land in `eval/results/<timestamp>-backend-experiment/` as
`backend-experiment.json` (full document, schema in
`src/eval/backend-experiment.ts`) and `backend-experiment.md` (side-by-side
summary). Commit the markdown of decision-relevant runs to this plan's results
section below.

### Metrics

Quality (from the existing scorer, must-detect FN mode):

- recall / precision / F1, corpus-level and per-case means across trials
- repeated-false-positive rate, empty-on-clean rate (clean cases)

Reliability (the pillar OpenCode is being challenged on):

- errored-trial rate, timed-out trials
- marker-fallback trials (response parsed without `FINAL_REVIEW_JSON` —
  a proxy for output-contract discipline per harness)

Cost/latency:

- trial duration p50/p95, mean cost and token totals per review
  (pi usage coverage itself is a finding: if pi reports no usage, that is a
  real gap to record)

### Decision criteria

Adopt pi as the default backend only if, on ≥3 trials over the full corpus:

1. recall (must-detect) is within noise of OpenCode (overlapping ±1 stddev) or
   better, **and**
2. precision is not worse by more than 0.05 mean, **and**
3. errored + timed-out trial rate ≤ OpenCode's, **and**
4. no provider-support regression for the models DiffOwl users actually
   configure (Copilot, Anthropic API, OpenAI, local/OpenRouter).

Keep OpenCode (and close the spike, deleting `src/pi/`) if pi loses on quality
or reliability, or if model/auth coverage turns out to be materially narrower
in practice. Either way, record the numbers here and in plans/README.md.

## Results

_(to be filled in from `backend-experiment.md` runs)_

| run | model | trials | outcome |
| --- | --- | --- | --- |
|  |  |  |  |

## Out of scope

- Backend abstraction beyond the minimal registry (no plugin interface).
- pi-specific prompt or tool tuning before the like-for-like baseline.
- Migrating retries/quota handling: OpenCode's retry loop and
  `quota.ts` string-matching stay opencode-only; pi's internal retry behavior
  is observed, not configured.
- MCP, CI, PR comments (unchanged roadmap: 0.5 → 0.6).
