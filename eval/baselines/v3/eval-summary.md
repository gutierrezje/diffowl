# DiffOwl Eval Summary

- Corpus version: `3d336b6fd10e6aa06b72a3ff53341f08ecb1a69f370e47078f24a096164dc8a4`
- Mode: both
- Model: opencode-go/deepseek-v4-flash
- Trials: 3
- Started: 2026-07-09T04:33:09.566Z
- Finished: 2026-07-09T04:55:33.920Z

## Aggregate

| Metric | DiffOwl | Baseline | Delta |
| --- | --- | --- | --- |
| Precision | 0.821 ± 0.183 | 0.778 ± 0.210 | +0.044 |
| Recall | 1.000 ± 0.000 | 0.952 ± 0.117 | +0.048 |
| F-beta | 0.857 ± 0.175 | 0.794 ± 0.201 | +0.063 |
| Repeated FP rate | 0.000 | 0.024 | -0.024 |
| Empty-on-clean rate | 0.800 | 0.667 | n/a |
| Latency p50 (ms) | 15348.000 | 10752.000 | +4424.643 |
| Usage mean cost | 0.001 | 0.001 | +0.000 |

## By Category (DiffOwl)

| Category | Cases | Precision | Recall | F-beta |
| --- | ---: | --- | --- | --- |
| bug | 9 | 0.833 ± 0.111 | 1.000 ± 0.000 | 0.889 ± 0.074 |
| clean | 5 | 0.800 ± 0.267 | 1.000 ± 0.000 | 0.800 ± 0.267 |

## Cases

| Case | Category | Precision | Recall | Errors |
| --- | --- | --- | --- | --- |
| async-clean | clean | 0.333 ± 0.471 | 1.000 ± 0.000 | 0 |
| check-then-act-race | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| extract-helper-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| fire-and-forget-async | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| harmless-trim | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| inverted-guard | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| missing-validation | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| off-by-one-slice | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| path-join-traversal | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| regression-reintroduced | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| rename-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| repeated-clean | clean | 0.667 ± 0.471 | 1.000 ± 0.000 | 0 |
| swallowed-error | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| unbounded-retry | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
