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
  --gate eval/gates/default.json \
  --out /tmp/diffowl-eval-run
```

Use `--case <id>` to run a subset. `--format json` prints the full results document to stdout.

Local run artifacts go to `eval/results/` (gitignored) unless `--out` is set.

## Baseline snapshots

Committed baselines live under `eval/baselines/<label>/`:

| File | Purpose |
| --- | --- |
| `manifest.json` | Run config, `corpus_version`, model, trials, tool versions |
| `eval-results.json` | Full schema v1 results (machine-readable) |
| `eval-summary.md` | Human-readable summary |

### Capture policy (v1)

1. Confirm `eval/corpus-manifest.json` matches the live corpus (`pnpm run test src/eval/corpus.test.ts`).
2. Run the full corpus with `--mode both --trials 3` and a fixed model.
3. Copy `eval-results.json` and `eval-summary.md` into `eval/baselines/v1/`.
4. Add `eval/baselines/v1/manifest.json` recording model, trials, `corpus_version`, DiffOwl version, and whether gates passed.
5. If `eval/gates/default.json` fails on real numbers, record actual metrics anyway; adjust gates or add a baseline-specific gate file in the baseline manifest — do not fake a passing run.

Refresh the baseline when the corpus version changes or when claiming a measured quality improvement.

## Comparing against a baseline

```bash
pnpm run eval -- \
  --compare eval/baselines/v1/eval-results.json \
  --out /tmp/diffowl-eval-run
```

`--compare` reports regressions but does **not** change the exit code unless you also pass `--fail-on-regression` (for CI/strict runs).

Text mode writes an additional `eval-comparison.md` beside the usual results. JSON mode embeds a top-level `comparison` object.

Comparison requires matching `corpus_version`, case ids, and per-case hashes from the results manifest. Run the full corpus when using `--compare` (omit `--case`).

## Gates

Default thresholds: `eval/gates/default.json`. Pass/fail is reported in results and sets CLI exit code when `--gate` is used.
