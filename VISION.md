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
- Agent-independent: DiffOwl can review changes produced by a person or any
  coding agent.
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

### Later - Team Intelligence

- Support shared, path-scoped policy packs.
- Learn from accepted and dismissed findings through explicit, reviewable
  suggestions.
- Add linked-repository context where users opt in.
- Provide review-quality and acceptance analytics.
- Consider an optional hosted synchronization layer only when local and CI
  workflows establish demand for shared state.

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
- Silently learning or enforcing team policy from user behavior.

## Near-Term Decision

The next product milestone should be 0.3: durable structured findings and JSON
output. This establishes the data model required for evaluation, deduplication,
agent integrations, CI annotations, and future team workflows.
