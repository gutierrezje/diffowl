# DiffOwl Eval Harness

Internal tooling for measured review quality. Hidden CLI: `diffowl eval` (or `pnpm run eval`).

## Corpus

- Fixtures: `eval/corpus/`
- Pinned version: `eval/corpus-manifest.json` (outside the hashed tree — see `hashCorpus()` in `src/eval/corpus.ts`)
- Case catalog: `eval/corpus/README.md`

Changing any fixture or corpus README updates `hashCorpus()`. After corpus edits:

1. Recompute the live hash (corpus tests print mismatches via manifest assertion).
2. Update `eval/corpus-manifest.json`.
3. Capture a new baseline snapshot (below).

## Running eval

Requires a model via `DIFFOWL_EVAL_MODEL` or `--model`.

```bash
export DIFFOWL_EVAL_MODEL="provider/model"

pnpm run eval -- \
  --mode both \
  --trials 3 \
  --out /tmp/diffowl-eval-run
```

Do not pass `--gate` for exploratory runs or baseline captures — a baseline
*defines* the level, so "failing" a threshold is not a meaningful outcome
there. See Gates below.

Use `--case <id>` to run a subset. `--format json` prints the full results document to stdout.

Local run artifacts go to `eval/results/` (gitignored) unless `--out` is set.

## Baseline snapshots

Committed baselines live under `eval/baselines/<label>/`:

| File | Purpose |
| --- | --- |
| `manifest.json` | Run config, `corpus_version`, model, trials, tool versions |
| `eval-metrics.json` | Compact metrics-first results for reading, dashboards, and baseline review |
| `eval-results.json` | Full schema v1 report with raw runs, scores, and debug details |
| `eval-summary.md` | Human-readable summary focused on aggregate and per-case results |

### Capture Policy

1. Confirm `eval/corpus-manifest.json` matches the live corpus (`pnpm run test src/eval/corpus.test.ts`).
2. Run the full corpus with `--mode both --trials 3` and a fixed model.
   Omit `--gate`: baseline captures record where we are; they cannot pass or
   fail.
3. Copy `eval-metrics.json`, `eval-results.json`, and `eval-summary.md` into `eval/baselines/<label>/`.
4. Add `eval/baselines/<label>/manifest.json` recording model, trials,
   `corpus_version`, and DiffOwl version. Record the actual metrics as
   measured — never adjust a run to look better.

Do not commit fixture-built or synthetic baselines under `eval/baselines/`. If no live snapshot exists for a label, leave that directory absent until capture is complete.

Refresh a baseline when the corpus version changes or when claiming a measured quality improvement.

## Comparing against a baseline

```bash
pnpm run eval -- \
  --compare eval/baselines/<label>/eval-results.json \
  --out /tmp/diffowl-eval-run
```

`--compare` reports regressions but does **not** change the exit code unless you also pass `--fail-on-regression` (for CI/strict runs).

Text mode writes an additional `eval-comparison.md` beside the usual results. JSON mode embeds a top-level `comparison` object.

Comparison requires matching `corpus_version`, case ids, and per-case hashes from the results manifest. Run the full corpus when using `--compare` (omit `--case`).

## Gates

Default thresholds: `eval/gates/default.json`. Pass/fail is reported in
results and sets the CLI exit code when `--gate` is used.

**Gates are opt-in tooling for CI/strict comparison runs, not a verdict on
the reviewer.** Per current policy (decision log, 2026-07-15): the corpus is
too small and noisy to hard-gate features, so gate output on any run is
advisory. The thresholds in `default.json` are aspirational values from plan
016, not calibrated standards — a run printing "Gates failed" means "below
those aspirational numbers," nothing more. Agents summarizing eval runs
should report the metrics, not a pass/fail verdict, unless the run was an
explicit `--fail-on-regression` comparison against a committed baseline.
