# DiffOwl Eval Summary

- Corpus version: `cfb05b57acb95ecc69b8da23b081236791ce31182b94e161dc19e782b0be81d4`
- Mode: diffowl
- Model: provider/model
- Trials: 3
- Started: 2026-06-29T12:00:00.000Z
- Finished: 2026-06-29T12:30:00.000Z

## Aggregate

| Metric | DiffOwl | Baseline | Delta |
| --- | --- | --- | --- |
| Precision | 1.000 ± 0.000 | n/a | n/a |
| Recall | 0.778 ± 0.248 | n/a | n/a |
| F-beta | 0.778 ± 0.248 | n/a | n/a |
| Repeated FP rate | 0.000 | n/a | n/a |
| Empty-on-clean rate | 1.000 | n/a | n/a |
| Latency p50 (ms) | 1000.000 | n/a | n/a |
| Usage mean cost | n/a | n/a | n/a |

## By Category (DiffOwl)

| Category | Cases | Precision | Recall | F-beta |
| --- | ---: | --- | --- | --- |
| bug | 3 | 1.000 ± 0.000 | 0.556 ± 0.157 | 0.556 ± 0.157 |
| clean | 3 | 1.000 ± 0.000 | 1.000 ± 0.000 | 1.000 ± 0.000 |

## Cases

| Case | Category | Precision | Recall | Errors |
| --- | --- | --- | --- | --- |
| async-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| fire-and-forget-async | bug | 1.000 ± 0.000 | 0.667 ± 0.471 | 0 |
| harmless-trim | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |
| missing-validation | bug | 1.000 ± 0.000 | 0.667 ± 0.471 | 0 |
| regression-reintroduced | bug | 1.000 ± 0.000 | 0.333 ± 0.471 | 0 |
| repeated-clean | clean | 1.000 ± 0.000 | 1.000 ± 0.000 | 0 |

## Gates

Status: **passed**
