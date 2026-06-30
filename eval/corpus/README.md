# Eval Corpus (v1)

Replayable mini-repos for measuring DiffOwl review quality. Each case is a directory with `case.json`, `base/`, and `change.patch`.

The pinned `corpus_version` lives in [`../corpus-manifest.json`](../corpus-manifest.json) (outside this tree so the manifest does not affect `hashCorpus()`).

## Cases

| ID | Category | Target | What it tests |
| --- | --- | --- | --- |
| `missing-validation` | bug | commit | Removes empty-string id validation; only guards `undefined` |
| `fire-and-forget-async` | bug | commit | Discards a `fetch` response and always returns `true` |
| `regression-reintroduced` | bug | commit | Reintroduces the fire-and-forget async defect after a fix |
| `harmless-trim` | clean | staged | Comment-only change to label formatting |
| `repeated-clean` | clean | commit | Comment on an already-safe validation path |
| `async-clean` | clean | commit | Comment on an async helper that already awaits its response |

## Expected findings

Bug cases declare anchors in `case.json` → `expected[]`:

- `file` — path relative to repo root after patch
- `line` — 1-based line number (± `line_tolerance`, default 2)
- `category` — optional keyword matched against finding title/body
- `must_detect` — included in recall gates when `true`

Clean cases must have `expected: []`.

## Adding or changing a case

1. Add or edit a case directory under `eval/corpus/<id>/`.
2. Run corpus tests (`pnpm run test src/eval/corpus.test.ts`).
3. Recompute `hashCorpus(eval/corpus)` and update `eval/corpus-manifest.json`.
4. Re-run the baseline capture (see [`../README.md`](../README.md)) and commit a new `eval/baselines/v*` snapshot.

Do not edit case fixtures without bumping the manifest version and refreshing the baseline.
