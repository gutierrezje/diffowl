# DiffOwl Eval Summary

- Corpus version: `90f7f0e612d07b388a77866602ddcdf21eb473b2fca01f175ff693eab1be9800`
- Mode: both
- Model: opencode-go/deepseek-v4-pro
- Trials: 3
- Started: 2026-07-07T22:05:40.676Z
- Finished: 2026-07-07T22:37:14.742Z

## Aggregate

| Metric | DiffOwl | Baseline | Delta |
| --- | --- | --- | --- |
| Precision | 0.873 ± 0.155 | 0.806 ± 0.274 | +0.067 |
| Recall | 0.976 ± 0.086 | 0.976 ± 0.086 | 0.000 |
| F-beta | 0.881 ± 0.158 | 0.821 ± 0.271 | +0.060 |
| Repeated FP rate | 0.000 | 0.000 | 0.000 |
| Empty-on-clean rate | 0.933 | 0.667 | n/a |
| Latency p50 (ms) | 11160.000 | 9670.000 | +3355.786 |
| Usage mean cost | 0.000 | 0.000 | 0.000 |

## By Category (DiffOwl)

| Category | Cases | Precision | Recall | F-beta |
| --- | ---: | --- | --- | --- |
| bug | 9 | 0.840 ± 0.156 | 0.963 ± 0.105 | 0.852 ± 0.164 |
| clean | 5 | 0.933 ± 0.133 | 1.000 ± 0.000 | 0.933 ± 0.133 |

## Cases

| Case | Category | Precision | Recall | Errors |
| --- | --- | --- | --- | --- |
| async-clean | clean | 0.667 ± 0.471 | 1.000 ± 0.000 | 0 |
| check-then-act-race | bug | 0.611 ± 0.283 | 1.000 ± 0.000 | 0 |
| extract-helper-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| fire-and-forget-async | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| harmless-trim | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| inverted-guard | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| missing-validation | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| off-by-one-slice | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| path-join-traversal | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| regression-reintroduced | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| rename-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 1 |
| repeated-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| swallowed-error | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| unbounded-retry | bug | 0.778 ± 0.314 | 0.667 ± 0.471 | 1 |

## Gates

Status: **passed**
