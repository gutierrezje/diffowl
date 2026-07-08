# Eval Corpus

Replayable mini-repos for measuring DiffOwl review quality. Each case is a directory with `case.json`, `base/`, and `change.patch`.

The pinned `corpus_version` lives in [`../corpus-manifest.json`](../corpus-manifest.json) (outside this tree so the manifest does not affect `hashCorpus()`).

## Cases

| ID | Category | Target | What it tests |
| --- | --- | --- | --- |
| `missing-validation` | bug | commit | Removes empty-string id validation; only guards `undefined` |
| `fire-and-forget-async` | bug | commit | Discards a `fetch` response and always returns `true` |
| `regression-reintroduced` | bug | commit | Reintroduces the fire-and-forget async defect after a fix |
| `swallowed-error` | bug | commit | Settings parse errors silently replaced with defaults; sits next to a legitimate ENOENT fallback |
| `off-by-one-slice` | bug | commit | Page-window trim removed; full pages return one extra row — the +1 read itself is intentional |
| `inverted-guard` | bug | commit | Negation dropped while extracting an authz guard; rest of the refactor is legitimate |
| `unbounded-retry` | bug | commit | Bounded retry loop changed to `while (true)` with no attempt increment |
| `check-then-act-race` | bug | commit | Pending-promise cache replaced by a check-then-act write across `await` |
| `path-join-traversal` | bug | commit | User-controlled path joined without sanitizing traversal segments |
| `harmless-trim` | clean | staged | Comment-only change to label formatting |
| `repeated-clean` | clean | commit | Comment on an already-safe validation path |
| `async-clean` | clean | commit | Comment on an async helper that already awaits its response |
| `rename-clean` | clean | staged | Local variable rename with behavior-preserving usage updates |
| `extract-helper-clean` | clean | commit | Name formatting moved into a helper without behavior changes |

## Case contract

Case-level fields:

- `id` — required; must match the case directory name
- `category` — required; `bug`, `clean`, or `mixed`; used for metrics/report grouping
- `language` — required; currently `typescript`
- `description` — required; concise human-readable scenario
- `target` — optional; defaults to `commit`
- `tags` — optional; descriptive only unless a future gate says otherwise
- `expected` — empty for clean cases; non-empty for bug/mixed cases

Bug and mixed cases declare anchors in `case.json` → `expected[]`:

- `file` — required; path relative to repo root after patch
- `line` — required; 1-based line number in the post-patch file
- `line_tolerance` — optional; default `2`; include only to intentionally widen
- `min_severity` — optional; default `warning`; include only to intentionally raise to `error`
- `must_detect` — optional; default `true`; include only when `false`, which means "credit if detected, but do not count as a false negative when missed"

Clean cases must have `expected: []`. Expected findings do not carry
`category`; matching is based on file, line tolerance, and minimum severity.

Committed corpus cases omit fields equal to their defaults.

## Adding or changing a case

1. Add or edit a case directory under `eval/corpus/<id>/`.
2. Run corpus tests (`pnpm exec vitest run src/eval/corpus.test.ts`).
3. Recompute `hashCorpus(eval/corpus)` and update `eval/corpus-manifest.json`.
4. Re-run the baseline capture (see [`../README.md`](../README.md)) and commit a new `eval/baselines/v*` snapshot.

Do not edit case fixtures without bumping the manifest version and refreshing the baseline.
