# DiffOwl 0.3: Durable Structured Findings

**Status:** implemented
**Version target:** 0.3.0

## Summary

Make SQLite the system of record for reviews and findings while retaining Markdown as an immutable human-readable export. Ship an agent-first JSON contract and a focused CLI for human inspection and lifecycle overrides.

0.3 does **not** include semantic deduplication, automatic resolution, retention cleanup, GitHub integration, SARIF, or migration of legacy reports.

## Data Model

- Add `better-sqlite3` and its TypeScript definitions using the pinned Node 22.14 runtime.
- Use WAL mode, foreign keys, a 5-second busy timeout, and transactional schema migrations.
- Store the database at `.diffowl/state.db`; `.diffowl/` remains gitignored.

### Tables

| Table                  | Purpose                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_migrations`    | Version and application timestamp                                                                                                              |
| `reviews`              | ID, timestamp, target kind/ref/commit, diff hash, model, reasoning, depth, session, summary, report path, diagnostics, timings, skipped reason |
| `findings`             | Stable ID, fingerprint, current status, first/last review, timestamps                                                                          |
| `finding_observations` | Review-specific file, line, severity, confidence, title, body, evidence, ordinal, observation classification                                   |
| `finding_events`       | observed, dismissed, deferred, fixed, reopened, or regressed events with actor, reason, commit, verification evidence                          |

### IDs and statuses

- Generate IDs as `rev_<UUID>` and `fnd_<UUID>`. CLI display may shorten them; JSON always returns full IDs.
- Statuses: `open`, `deferred`, `dismissed`, `fixed`, `regressed`.
- A review is complete only when all associated findings are `fixed` or `dismissed` (computed, not stored).
- Absence from a later model review never resolves a finding.

## Identity And Reconciliation

Compute a versioned SHA-256 fingerprint from normalized repository-relative path, title, and evidence; use body when evidence is absent.

Normalization: NFKC, lowercase, trim, collapse whitespace. Exclude line numbers.

Do **not** use fuzzy, embedding, or model-assisted identity in 0.3.

### Reconciliation rules

| Existing status           | Behavior                                            |
| ------------------------- | --------------------------------------------------- |
| Unknown fingerprint       | Create `open` finding, classify as `new`            |
| `open` or `regressed`     | Preserve status, classify as `existing`             |
| `deferred` or `dismissed` | Record observation, suppress from actionable output |
| `fixed`                   | Transition to `regressed`, surface as actionable    |

Store only candidates that pass confidence and changed-file filtering. Outside-file and below-threshold candidates remain diagnostics, not durable findings.

## Public Interfaces

### `diffowl review --format text|json`

- `text` remains the default.
- JSON mode: same stateful review, persists SQLite state, writes Markdown report, disables spinners/ANSI, writes exactly one versioned JSON document to stdout.
- JSON schema version 1: review identity, target, model, depth, session, summary, status, report path; findings with stable IDs, fingerprints, lifecycle status, observation classification, location, content, timestamps, occurrence count; suppression counts, diagnostics, timings.
- JSON failures: empty stdout, one structured error document on stderr, nonzero exit.

### `diffowl findings` commands

| Command                                                                                    | Purpose                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `diffowl findings`                                                                         | List unresolved findings (default) |
| `diffowl findings show <locator>`                                                          | Inspect one finding                |
| `diffowl findings dismiss <locator> --reason <text>`                                       | Dismiss                            |
| `diffowl findings defer <locator> --reason <text>`                                         | Defer                              |
| `diffowl findings fix <locator> --note <text> --verified-by <text> [...] [--commit <ref>]` | Mark fixed                         |
| `diffowl findings reopen <locator> --reason <text>`                                        | Reopen                             |

Locators: full ID, unambiguous ID prefix, or `latest:<ordinal>`. Ambiguous/missing locators fail without changing state.

Mutation commands accept `--actor user|agent` (default `user`) and return the updated full finding record.

## Reports And Compatibility

- Continue writing timestamped Markdown and `latest.md`.
- Add `schema_version`, `review_id`, session ID, and project root to frontmatter.
- Include durable finding ID in each heading while preserving numeric ordinals.
- Show `new`, `existing`, and `regressed` observations distinctly.
- Dismissed/deferred matches contribute only suppression counts unless `--verbose`.
- Reports are immutable snapshots; lifecycle commands update SQLite only.
- Preserve pre-0.3 reports unchanged; keep them chat-capable.
- Update `diffowl-resolve` skill: new reports use durable IDs and lifecycle CLI; legacy reports keep Markdown checklist/archive workflow. Never claim fixed without recorded verification.

## Implementation Order

1. SQLite dependency, database initialization, migrations, repositories, transaction tests.
2. Durable review/finding types, fingerprinting, reconciliation, lifecycle transitions, event history.
3. Integrate persistence after model filtering and before report generation; persist doc-only skips but not failed reviews.
4. Versioned JSON rendering; centralize text/JSON success and error output.
5. Finding query and lifecycle commands with locator resolution.
6. Markdown rendering, report metadata, resolution skill, README, 0.3 migration notes.
7. Dogfood repeated reviews to verify deduplication, dismissal suppression, and regression reopening.

## Test Plan

- Database init, repeat opening, migration rollback, newer-schema rejection, WAL config, concurrent foreground/hook access.
- Fingerprints stable across line movement and whitespace; changed evidence/title creates separate finding.
- Every lifecycle transition, invalid transition, event record, actor, reason, verification, optional commit.
- Repeated open findings deduplicate; dismissed/deferred suppress; fixed reopen as regressed; missing findings stay unresolved.
- JSON stdout: no spinner, ANSI, or prose; validates against schema v1.
- Markdown reports contain durable IDs and stay unchanged after lifecycle mutations.
- Legacy report listing and `diffowl chat` continue working.
- Hook reviews persist state without changing non-blocking behavior.
- `pnpm run test`, `lint`, `format:check`, `build` on Ubuntu and Windows with Node 22.14.

## Assumptions

- Markdown is an export, not authoritative state.
- No existing report is imported into SQLite.
- Review cleanup/archive/delete policy moves to a later 0.3.x release.
- SQLite write failure before model execution blocks the review; Markdown write failure after persistence becomes a diagnostic with `reportPath: null`.
- No finding is automatically fixed because a later review failed to mention it.

## Current Codebase Gaps (0.2.1)

| Area             | Today                                        | 0.3 needs                                               |
| ---------------- | -------------------------------------------- | ------------------------------------------------------- |
| Persistence      | Markdown only in `.diffowl/reviews/`         | `.diffowl/state.db` + immutable Markdown export         |
| Finding identity | Ordinal `Finding N` per report               | `fnd_<UUID>` + versioned SHA-256 fingerprint            |
| Lifecycle        | Markdown `## Resolution` checklist via skill | SQLite events + `diffowl findings *` commands           |
| Review output    | Text + colored Markdown to stdout            | `--format json` with schema v1 on stdout                |
| Frontmatter      | `session_id`, `project_root`                 | + `schema_version`, `review_id`                         |
| Status           | `Open` if any finding in snapshot            | Computed from durable finding statuses                  |
| Filtering        | In `cli.ts` after model run                  | Same point, but only filtered candidates become durable |

## Proposed Module Layout

```
src/
├── state/
│   ├── db.ts              # open, WAL, busy timeout, migrations
│   ├── migrations/        # versioned SQL
│   ├── repositories/      # reviews, findings, events
│   ├── fingerprint.ts     # normalization + SHA-256
│   ├── reconcile.ts       # observation → finding mapping
│   └── lifecycle.ts       # dismiss/defer/fix/reopen transitions
├── output/
│   ├── json.ts            # schema v1 render + error envelope
│   └── locator.ts         # ID prefix / latest:N resolution
```

Integration point in `cli.ts`: after confidence/changed-file filtering (~line 250), before `renderMarkdown`.
