# DiffOwl Eval Summary

- Corpus version: `3d336b6fd10e6aa06b72a3ff53341f08ecb1a69f370e47078f24a096164dc8a4`
- Mode: both
- Model: opencode-go/deepseek-v4-pro
- Trials: 3
- Started: 2026-07-08T01:57:21.383Z
- Finished: 2026-07-08T02:32:19.805Z

## Aggregate

| Metric | DiffOwl | Baseline | Delta |
| --- | --- | --- | --- |
| Precision | 0.758 ± 0.246 | 0.726 ± 0.272 | +0.032 |
| Recall | 0.952 ± 0.117 | 0.952 ± 0.117 | 0.000 |
| F-beta | 0.782 ± 0.210 | 0.726 ± 0.264 | +0.056 |
| Repeated FP rate | 0.024 | 0.000 | +0.024 |
| Empty-on-clean rate | 0.800 | 0.533 | n/a |
| Latency p50 (ms) | 14141.000 | 11467.000 | +3018.429 |
| Usage mean cost | 0.000 | 0.000 | 0.000 |

## By Category (DiffOwl)

| Category | Cases | Precision | Recall | F-beta |
| --- | ---: | --- | --- | --- |
| bug | 9 | 0.735 ± 0.231 | 0.926 ± 0.139 | 0.772 ± 0.171 |
| clean | 5 | 0.800 ± 0.267 | 1.000 ± 0.000 | 0.800 ± 0.267 |

## Repeated False Positives

- path-join-traversal: `v1:9f98cb74ed82a74a03d2044a212ea9cda744756b3674cdaec9bb3a14c12bf2db` (2 trials) — sanitizeName is now dead code (src/files.ts)

## Cases

| Case | Category | Precision | Recall | Errors |
| --- | --- | --- | --- | --- |
| async-clean | clean | 0.333 ± 0.471 | 1.000 ± 0.000 | 0 |
| check-then-act-race | bug | 0.333 ± 0.236 | 0.667 ± 0.471 | 0 |
| extract-helper-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| fire-and-forget-async | bug | 0.833 ± 0.236 | 1.000 ± 0.000 | 0 |
| harmless-trim | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| inverted-guard | bug | 1.000 ± 0.000 | 0.667 ± 0.471 | 1 |
| missing-validation | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| off-by-one-slice | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| path-join-traversal | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| regression-reintroduced | bug | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| rename-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| repeated-clean | clean | 0.667 ± 0.471 | 1.000 ± 0.000 | 0 |
| swallowed-error | bug | 0.667 ± 0.236 | 1.000 ± 0.000 | 0 |
| unbounded-retry | bug | 0.444 ± 0.079 | 1.000 ± 0.000 | 0 |

## Gates

Status: **failed**

- empty-on-clean rate 0.7999999999999999 is below minimum 0.9
