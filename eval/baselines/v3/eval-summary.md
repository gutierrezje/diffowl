# DiffOwl Eval Summary

## At a Glance

- Model: opencode-go/deepseek-v4-flash
- Corpus: `3d336b6fd10e6aa06b72a3ff53341f08ecb1a69f370e47078f24a096164dc8a4`
- Scope: 14 cases, 3 trials, both mode
- DiffOwl precision: 0.754 ± 0.252
- DiffOwl recall: 0.976 ± 0.086
- Repeated false-positive rate: 0.000
- F-beta delta vs baseline: -0.056
- Gate check: recorded with observations

## Run Details

- Corpus version: `3d336b6fd10e6aa06b72a3ff53341f08ecb1a69f370e47078f24a096164dc8a4`
- Mode: both
- Model: opencode-go/deepseek-v4-flash
- Trials: 3
- Started: 2026-07-15T22:47:16.814Z
- Finished: 2026-07-15T23:05:09.766Z

## Aggregate

| Metric | DiffOwl | Baseline | Delta |
| --- | --- | --- | --- |
| Precision | 0.754 ± 0.252 | 0.825 ± 0.234 | -0.071 |
| Recall | 0.976 ± 0.086 | 0.952 ± 0.117 | +0.024 |
| F-beta | 0.770 ± 0.228 | 0.825 ± 0.224 | -0.056 |
| Repeated FP rate | 0.000 | 0.000 | 0.000 |
| Empty-on-clean rate | 0.667 | 0.800 | n/a |
| Latency p50 (ms) | 13813.500 | 10797.286 | +3016.214 |
| Usage mean cost | 0.001 | 0.001 | +0.000 |

## By Category (DiffOwl)

| Category | Cases | Precision | Recall | F-beta |
| --- | ---: | --- | --- | --- |
| bug | 9 | 0.802 ± 0.206 | 0.963 ± 0.105 | 0.827 ± 0.149 |
| clean | 5 | 0.667 ± 0.298 | 1.000 ± 0.000 | 0.667 ± 0.298 |

## Cases

| Case | Category | Precision | Recall | Errors |
| --- | --- | --- | --- | --- |
| async-clean | clean | 0.333 ± 0.471 | 1.000 ± 0.000 | 0 |
| check-then-act-race | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| extract-helper-clean | clean | 0.667 ± 0.471 | 1.000 ± 0.000 | 0 |
| fire-and-forget-async | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| harmless-trim | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| inverted-guard | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| missing-validation | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| off-by-one-slice | bug | 1.000 ± 0.000 | 0.667 ± 0.471 | 1 |
| path-join-traversal | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| regression-reintroduced | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| rename-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| repeated-clean | clean | 0.333 ± 0.471 | 1.000 ± 0.000 | 0 |
| swallowed-error | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| unbounded-retry | bug | 0.389 ± 0.079 | 1.000 ± 0.000 | 0 |

## Gate Observations

Status: **recorded**

- empty-on-clean rate 0.6666666666666667 is below minimum 0.9
