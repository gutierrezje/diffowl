# DiffOwl Product Vision

## Vision

DiffOwl is the local, provider-neutral verification layer for agent-generated
code.

Coding agents are increasingly responsible for producing changes, but the same
agent that writes a patch should not be its only reviewer. DiffOwl provides an
independent review loop that runs on developer-controlled infrastructure, uses
the model provider they choose, and produces durable, actionable findings.

DiffOwl should become more than a scheduled prompt over a Git diff. Its value
comes from understanding change impact, remembering review outcomes, reducing
repeated noise, and verifying that confirmed problems were actually resolved.

## Product Position

DiffOwl is:

- Local-first: source code and review state stay on infrastructure controlled
  by the user unless they explicitly publish or synchronize them.
- Provider-neutral: review workflows are not tied to one model vendor.
- Forge-agnostic: DiffOwl is built on git, not on a hosting platform. It works
  identically whether the remote is GitHub, GitLab, or bare — including forges
  that hosted PR bots treat as second-class.
- Agent-independent: DiffOwl can review changes produced by a person or any
  coding agent. Independence is context independence — a clean-room prompt and
  separately built context — not a claim that the reviewer uses different
  weights than the writer.
- Evidence-driven: findings identify concrete code, impact, and confidence.
- Stateful: findings persist across commits and have a lifecycle.
- Automation-friendly: the same review engine serves local hooks, CI, editors,
  and coding agents.

DiffOwl is not intended to become another general-purpose coding agent. Its
role is to independently inspect, challenge, and verify changes.

## Product Goals

### Trustworthy Reviews

Improve review precision and recall against measured examples rather than
adding prompt complexity without evidence. Users should be able to understand
why a finding was raised and whether it has appeared before.

### Durable Finding Lifecycle

Treat findings as product entities rather than transient Markdown sections.
Each finding should have stable identity, history, disposition, and the ability
to reopen when a regression occurs.

### Change-Impact Understanding

Build a bounded, incrementally maintained understanding of symbols,
dependencies, callers, tests, configuration, and schemas affected by a change.
Review depth should come from relevant context, not indiscriminate repository
scanning.

### Independent Verification

Integrate with coding-agent workflows so an agent can submit a patch, receive
structured findings, make corrections, and ask DiffOwl to verify the result.
The reviewer and implementer should remain separate roles.

### Local and Team Workflows

Keep local usage simple while exposing structured output for CI and repository
hosting platforms. Teams should be able to share policy without being required
to upload private source code to a DiffOwl service.

## Product Model

DiffOwl should separate three kinds of state:

1. **Repository policy**: committed configuration, path-scoped rules, severity
   thresholds, and intentional suppressions.
2. **Local intelligence**: a gitignored finding store, code index, review
   sessions, and model execution data.
3. **Team surfaces**: GitHub Checks, SARIF, CI artifacts, and an optional future
   synchronization service.

Markdown reports remain useful human-readable exports, but they should not be
the long-term system of record.

Learned preferences must not silently rewrite repository policy. DiffOwl may
propose a scoped configuration change after repeated dismissals, but a person
must review and accept it.

## Roadmap

Roadmap versions describe cohesive product milestones, not fixed delivery
dates.

### 0.2.x - Reliable Review Runner

- Stabilize Git snapshot selection, hooks, context collection, model execution,
  and report generation.
- Maintain a green cross-platform test, lint, typecheck, and build baseline.
- Release correctness and portability fixes without expanding product scope.

### 0.3 - Structured, Durable Findings

- Add machine-readable JSON output as a supported public contract.
- Give findings stable fingerprints independent of report numbering.
- Persist finding state locally with introduced, observed, resolved, dismissed,
  deferred, and regressed states.
- Deduplicate repeated findings across commits.
- Add CLI commands to list, inspect, dismiss, defer, and resolve findings.
- Keep Markdown as an export generated from structured state.

### 0.3.x - Measured Review Quality (in progress)

Ship incrementally on `0.3.x` patch releases, developed on a feature branch
until the harness is usable end-to-end:

- Add a replayable evaluation harness using known bug-introducing and clean
  changes.
- Compare DiffOwl with a plain agent review prompt.
- Track precision, recall, repeated false positives, latency, and model cost.
- Record the exact review input and configuration needed to reproduce results.
- Use evaluation results to guide context and prompt changes.

The eval harness is internal tooling until `diffowl eval` lands; target
**0.3.2+**, not a `0.4.0` minor bump. Quality claims should not be made until
the harness produces repeatable results on a stabilized corpus.

Corpus stabilization includes a single expectation contract: every case scores
under the same rules (line tolerance, severity floors, category requirements
decided once, enforced by a schema-conformance gate), so aggregate metrics
reflect model quality rather than per-case authoring drift.

### 0.4 - Branch Review and the Pre-PR Gate

Meet agentic workflows at their natural unit: the branch, not the commit.

- Add `diffowl review --base [ref]`: review `HEAD` against the merge base with
  the given ref (three-dot semantics, the same diff a PR shows), defaulting to
  the auto-detected default branch. Committed state only; the working tree and
  index stay out of branch reviews so results are reproducible.
- Make repeat branch reviews delta-aware: as a branch grows, re-reviews lean on
  durable findings to report `new`, `existing`, and `regressed` rather than
  re-litigating the whole diff.
- Add a blocking gate mode with meaningful exit codes so DiffOwl can serve as
  a pre-push or CI quality gate. DiffOwl emits structured findings and a
  verdict; the user composes the policy. DiffOwl produces data, it does not
  own the pipeline outcome.
- Validate model output against the finding schema at the session boundary and
  retry with error feedback on invalid output instead of failing the review.
- Spike a Codex-subprocess backend behind the existing backend seam. Rationale:
  it is the one backend that can unlock a subscription users already pay for
  (Anthropic's terms keep Claude subscriptions out of reach for any third-party
  path, so for Claude a direct backend buys nothing over OpenCode). Adopt only
  if it clears the same eval gates the pi spike failed; subscription economics
  alone are not sufficient evidence.

### 0.5 - Incremental Impact Graph

- Index supported-language symbols, imports, calls, and likely tests.
- Update the index incrementally from changed files.
- Query the smallest relevant subgraph for each changed symbol.
- Include configuration and schema consumers where relationships can be
  determined reliably.
- Start with TypeScript and add languages only when evaluation demonstrates
  value.

### 0.6 - Agent and CI Verification Loop

- Expose a stable agent-facing interface through CLI JSON and, where useful,
  MCP.
- Allow coding agents to submit changes, consume findings, and request
  verification after fixes.
- Add SARIF output and a GitHub Action running on user-controlled
  infrastructure.
- Publish annotations while updating existing findings instead of posting
  duplicate comments.

Running an agent review from a PR event is now commodity infrastructure —
generic agent bridges (e.g. Pullfrog) do it with a prompt and a key. The
Action is only defensible through what a stateless prompt-runner cannot carry:
durable finding identity across pushes, updated rather than duplicated
comments, and measured quality. Treat the Action as the distribution wedge —
how people discover DiffOwl — while the local loop is why they stay. The
Action exposes findings as structured, composable step output.

### Later - Team Intelligence

Team state is three different needs, served in order and mostly through git:

1. **Visibility** — teammates see findings on a change. Served by 0.6 team
   surfaces (PR comments, SARIF, CI artifacts) under a
   canonical-reviewer-per-change model: one review run (CI or the author's
   machine) is the reviewer of record for a branch, and its output travels
   with the PR. Other checkouts' local state stays a personal cache; there is
   no multi-master database sync.
2. **Decisions** — dispositions that should not be re-litigated. Served by an
   append-only disposition log committed to the repo (git as the transport,
   conflict-free by construction), attached to the canonical review's finding
   identities. The local database becomes a rebuildable view over own reviews
   plus the shared log.
3. **Policy** — classes of findings the team never wants. Served by promoting
   repeated dismissals into committed, path-scoped suppression rules through
   an explicit, human-approved change. This is where most dismissals should
   terminate; it drains the backlog instead of accumulating open records.

Prerequisite for any shared identity: a more code-anchored fingerprint
(anchor on file plus quoted evidence; drop model-phrased prose from the hash),
since independently generated reviews will not phrase the same issue
identically.

Learned preferences live in three layers, strongest first: deterministic
suppression at the reporting layer (model-independent by construction),
prompt-injected rules (portable, A/B-tested against the corpus), and
per-model calibration priors derived from disposition history. Team
preferences graduate to committed policy; model-specific noise profiles stay
in local state and evaporate when the model changes — never fossilize one
model's quirks into policy that would suppress a better model's findings.

- Add linked-repository context where users opt in.
- Provide review-quality and acceptance analytics.
- Consider an optional hosted synchronization layer only after the git-based
  tiers above prove insufficient; a server adds cross-repo aggregation and
  dashboards, nothing the tiers require.

## Success Measures

DiffOwl should be judged by outcomes:

- Confirmed issue recall on a repeatable evaluation corpus.
- Precision of actionable findings.
- Rate of findings accepted, dismissed, or repeated after dismissal.
- Regressions reopened correctly.
- Review latency and model cost by depth profile.
- Percentage of findings resolved and independently verified.
- Setup time from installation to the first useful review.

Raw finding count is not a success metric. More comments can make a reviewer
less useful.

## Product Principles

- Measure before claiming review quality.
- Prefer deterministic preprocessing and structured state over larger prompts.
- Keep context and execution bounded.
- Treat model findings as candidates until verified.
- Preserve user control over source code, providers, policy, and data.
- Make suppressions scoped, visible, and reversible.
- Add abstractions when a product capability requires them, not to polish the
  architecture in isolation.
- Favor one coherent milestone over many disconnected features.

## Non-Goals

Until the core review loop is demonstrably strong, DiffOwl will not prioritize:

- Becoming a general coding or autonomous implementation agent.
- Building a hosted dashboard before durable local state exists.
- Adding multiple reviewer agents for marketing value.
- Automatically modifying code without a separate verification step.
- Supporting every programming language before supported languages are
  evaluated well.
- Competing feature-for-feature with hosted pull-request review platforms.
- Competing on generality with agent-orchestration bridges (Pullfrog and
  similar): arbitrary prompts, arbitrary triggers, implementation tasks. A
  verification layer that also implements features stops being independent.
- Silently learning or enforcing team policy from user behavior.

## Near-Term Decision

0.3 (durable structured findings, JSON output) has shipped and the eval
harness is merged. The next milestone is finishing 0.3.x — a stabilized,
contract-consistent corpus and a live baseline — followed by 0.4 branch
review. Branch review is the single largest workflow unlock for agent-driven
development: agents produce many commits per session, and the reviewable unit
users care about before a PR is the branch delta, not each intermediate
commit. Quality changes (prompt, contract, backends) continue to merge only
on eval evidence.
