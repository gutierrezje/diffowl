# DiffOwl Spike: pi Backend Experiment

**Status:** concluded — pi not adopted; cleanup should remove spike backend code
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

Decision-relevant run:

```bash
node dist/cli.js eval-backends \
  --trials 3 \
  --model opencode-go/deepseek-v4-pro \
  --out /tmp/diffowl-pi-spike-full-t3
```

Artifact: `/tmp/diffowl-pi-spike-full-t3/backend-experiment.md`

| run | model | trials | outcome |
| --- | --- | --- | --- |
| full corpus, OpenCode vs pi | `opencode-go/deepseek-v4-pro` | 3 per case | **Reject pi as default**. Recall tied at 1.00 and reliability tied at 0% errors/timeouts/marker fallbacks, but pi precision was 0.67 vs OpenCode 0.78, a 0.11 regression that fails the allowed 0.05 precision-loss gate. |

Corpus summary:

| backend | version | recall | precision | F1 | latency p50 | latency p95 | mean cost | error rate | timeouts | marker fallbacks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opencode | 1.17.14 | 1.00 | 0.78 | 0.81 | 21.2s | 46.5s | $0.0113 | 0% | 0 | 0 |
| pi | 0.80.3 | 1.00 | 0.67 | 0.72 | 33.1s | 38.7s | $0.0115 | 0% | 0 | 0 |

Per-case deltas:

| case | OpenCode precision | pi precision | note |
| --- | --- | --- | --- |
| `async-clean` | 0.33 | 0.00 | both backends over-reported on this clean case; pi was worse in all trials |
| `fire-and-forget-async` | 0.67 | 0.50 | pi kept recall but emitted more extra findings |
| `harmless-trim` | 1.00 | 1.00 | tied |
| `missing-validation` | 0.83 | 0.67 | pi kept recall but emitted more extra findings |
| `regression-reintroduced` | 0.83 | 0.83 | tied |
| `repeated-clean` | 1.00 | 1.00 | tied |

Interpretation:

- The in-process pi SDK backend met the recall and reliability requirements.
- It did not meet the precision requirement: mean precision regressed by 0.11,
  more than the allowed 0.05.
- Usage reporting is present for pi in this run, so usage-shape extraction is
  not the blocking issue.
- OpenCode remains the committed backend. The next cleanup change should delete
  `src/pi/`, remove `review --backend pi`/`DIFFOWL_BACKEND=pi`, and either delete
  or narrow the `eval-backends` harness.

## Out of scope

- Backend abstraction beyond the minimal registry (no plugin interface).
- pi-specific prompt or tool tuning before the like-for-like baseline.
- Migrating retries/quota handling: OpenCode's retry loop and
  `quota.ts` string-matching stay opencode-only; pi's internal retry behavior
  is observed, not configured.
- MCP, CI, PR comments (unchanged roadmap: 0.5 → 0.6).
