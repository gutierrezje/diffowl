# DiffOwl Eval Summary

## At a Glance

- Model: opencode-go/deepseek-v4-flash
- Corpus: `5228dbfaabb9fc1cab62c784421c332141b3bf84e5787b864dfad30056b4385d`
- Scope: 16 cases, 3 trials, both mode
- DiffOwl precision: 0.823 ± 0.208
- DiffOwl recall: 0.854 ± 0.333
- Repeated false-positive rate: 0.000
- F-beta delta vs baseline: +0.021

## Run Details

- Corpus version: `5228dbfaabb9fc1cab62c784421c332141b3bf84e5787b864dfad30056b4385d`
- Mode: both
- Model: opencode-go/deepseek-v4-flash
- Trials: 3
- Started: 2026-07-23T23:05:12.565Z
- Finished: 2026-07-23T23:23:15.936Z

## Aggregate

| Metric | DiffOwl | Baseline | Delta |
| --- | --- | --- | --- |
| Precision | 0.823 ± 0.208 | 0.750 ± 0.333 | +0.073 |
| Recall | 0.854 ± 0.333 | 0.875 ± 0.331 | -0.021 |
| F-beta | 0.785 ± 0.323 | 0.764 ± 0.338 | +0.021 |
| Repeated FP rate | 0.000 | 0.000 | 0.000 |
| Empty-on-clean rate | 0.933 | 0.733 | n/a |
| Latency p50 (ms) | 12619.563 | 8646.125 | +3973.438 |
| Usage mean cost | 0.001 | 0.001 | +0.000 |

## By Category (DiffOwl)

| Category | Cases | Precision | Recall | F-beta |
| --- | ---: | --- | --- | --- |
| bug | 11 | 0.773 ± 0.216 | 0.788 ± 0.383 | 0.717 ± 0.359 |
| clean | 5 | 0.933 ± 0.133 | 1.000 ± 0.000 | 0.933 ± 0.133 |

## Cases

| Case | Category | Precision | Recall | Errors |
| --- | --- | --- | --- | --- |
| async-clean | clean | 0.667 ± 0.471 | 1.000 ± 0.000 | 0 |
| check-then-act-race | bug | 0.667 ± 0.471 | 0.667 ± 0.471 | 0 |
| extract-helper-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| fire-and-forget-async | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| harmless-trim | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| inverted-guard | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| keep-distinct-in-same-symbol | bug | 0.333 ± 0.471 | 0.000 ± 0.000 | 1 |
| missing-validation | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| off-by-one-slice | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| path-join-traversal | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| recognize-same-across-commits | bug | 0.667 ± 0.471 | 0.000 ± 0.000 | 1 |
| regression-reintroduced | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| rename-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| repeated-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| swallowed-error | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| unbounded-retry | bug | 0.500 ± 0.000 | 1.000 ± 0.000 | 0 |
