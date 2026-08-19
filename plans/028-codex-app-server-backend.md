# Codex App Server native backend spike

**Design date:** 2026-08-17
**Issue:** [#103](https://github.com/gutierrezje/diffowl/issues/103)
**Type:** disposable experiment; no user-facing backend selection

## Decision

Test Codex through its native App Server protocol, not ACP and not
`codex exec`. Keep the experiment behind DiffOwl's existing injected
`runReview` seam and leave the production OpenCode path unchanged until the
evidence supports a GO decision.

The spike owns one `codex app-server --stdio` child per review. It proves local
ChatGPT authentication, read-only execution, structured output, bounded retry,
cancellation, process teardown, and unchanged downstream filtering and
persistence. All App Server protocol and evidence code stays under one
experimental directory so a NO-GO result is mechanically deletable.

This follows the one-adapter rule from plan 017: a second production backend
interface is premature until the second backend proves viable.

## Why App Server

The official guide positions App Server for deep integrations that need
authentication, conversation state, approvals, and streamed events. The
official TypeScript SDK is the smaller automation interface, but it wraps
`codex exec` and hides `account/read`, turn identifiers, direct
`turn/interrupt`, and process-lifecycle evidence. Those are the questions this
spike needs to answer. [App Server guide](https://developers.openai.com/codex/app-server.md)
[Codex SDK source](https://github.com/openai/codex/tree/main/sdk/typescript)

T3 Code is implementation precedent, not protocol authority. At pinned commit
`a4cc1367`, it launches App Server directly and translates native events behind
its Codex provider; it does not route that path through ACP.
[T3 runtime](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/server/src/provider/Layers/CodexSessionRuntime.ts)
[typed client](https://github.com/pingdotgg/t3code/tree/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/packages/effect-codex-app-server)

## Existing ownership and the experimental seam

`runReviewPipeline` already owns the durable product work:

- load the target and build/render local context;
- filter findings by confidence and changed files;
- reconcile durable finding identity and persist the review;
- enrich findings and write the Markdown report.

Its injected `ReviewPipelineDeps.runReview` is the narrow experimental seam.
The surrounding pipeline still prepares OpenCode unconditionally and labels
two timings as OpenCode. The spike replaces `ensureServer` and
`isServerRunning` only in its dependency closure and omits `onStatus`, so it
neither starts OpenCode nor shows a false connection message. It records
accurate Codex phases separately. Production orchestration is not refactored in
this issue.

Prompt construction, complete-document validation, retry policy, progress
types, and cancellation errors currently live under `src/opencode/`. The spike
imports those policies rather than copying or relocating them. A GO result is
the trigger for a separate ownership extraction.

## Caller-facing shape

The experiment exposes one function, not a generic backend interface:

```ts
type CodexOutputStrategy = "marker" | "output-schema";

interface CodexSpikeInput {
  review: Omit<ReviewPipelineInput, "onStatus">;
  signal?: AbortSignal;
  onProgress?: (event: ReviewProgressEvent) => void;
  codex: {
    protocol: { executable: string; prefixArgs?: readonly string[]; env?: ProcessEnv };
    appServer: { executable: string; args?: readonly string[]; env?: ProcessEnv };
    model: string;
    strategy: CodexOutputStrategy;
    artifactDirectory: string;
    timeoutMs: number;
    interruptDeadlineMs: number;
    teardownDeadlineMs: number;
    includeIgnoredRepositoryPaths: boolean;
  };
}

type CodexSpikeOutcome =
  | {
      kind: "completed";
      protocol: CodexProtocolEvidence;
      commandProvenance: CommandProvenance;
      codex: CodexReviewEvidence;
      pipeline: ReviewPipelineOutcome;
      artifactPath: string;
    }
  | {
      kind: "not-run";
      protocol: CodexProtocolEvidence;
      commandProvenance: CommandProvenance;
      pipeline: ReviewPipelineOutcome;
      artifactPath: string;
    }
  | {
      kind: "failed";
      protocol: CodexProtocolEvidence | null;
      commandProvenance: CommandProvenance;
      codex: CodexReviewEvidence | null;
      failureEvidence: CodexReviewFailureEvidence | null;
      pipeline: ReviewPipelineOutcome | null;
      failure: CodexSpikeFailure;
      artifactPath: string | null;
    };

function runCodexAppServerSpike(input: CodexSpikeInput): Promise<CodexSpikeOutcome>;
```

The wrapper supplies a runner that returns the existing `ReviewResult` shape;
the Codex thread ID temporarily occupies its opaque `sessionId` slot. Rich
backend evidence is returned and written separately. The current persistence
record therefore does not falsely claim to contain complete Codex provenance.

No production CLI flag or config key is added. Live and matched-case runs are
explicit package scripts guarded by environment variables.

## Internal module shape

```text
runCodexAppServerSpike
  -> runReviewPipeline(existing deps + experiment overrides)
       -> executeCodexReview
            -> AppServerPeer (private JSONL/RPC/process boundary)
            -> existing prompt + review-document policy
       -> existing filters, identity, persistence, renderer
```

`AppServerPeer` is private and deliberately small. It uses `execa`, parses each
stdout line as `unknown`, validates the narrow message subset at the boundary,
correlates request IDs, emits validated notifications, bounds/redacts stderr,
and closes idempotently. It is not a reusable JSON-RPC library and it does not
export generated protocol types.

`executeCodexReview` owns the semantic state machine:

```text
spawned -> initialized -> authenticated -> thread-ready
        -> turn-active -> turn-terminal -> thread-ready (retry)
                                      \-> closing -> closed
```

An abort during `turn-active` enters `interrupting`, sends one interrupt, waits
for terminal interruption within the shared deadline, and then closes.

## Required protocol behavior

The tested local CLI during design was `codex-cli 0.147.0`. Every live run must
record its own executable version and regenerate stable TypeScript and JSON
Schema artifacts from that same executable. Generated files live in a temporary
directory; the evidence artifact stores their manifests and hashes. Do not use
`experimentalApi` or vendor the generated tree.

For one review, including validation retries:

1. Spawn `codex app-server --stdio`. The transport is newline-delimited JSON-RPC
   without the `jsonrpc` member.
2. Send `initialize`, await its response, then send `initialized`.
3. Call `account/read` with `refreshToken: false`; require an existing ChatGPT
   account and never invoke a login flow.
4. Call `thread/start` with the repository `cwd`, explicit model,
   `approvalPolicy: "never"`, `sandbox: "read-only"`, and an ephemeral thread.
5. Call `turn/start` with `sandboxPolicy: { type: "readOnly", networkAccess:
false }`, the rendered DiffOwl prompt, and the schema only in schema mode.
6. Aggregate agent-message deltas by item ID, replace them with authoritative
   completed item content when present, and accept only events for the active
   thread and turn.
7. Treat matching `turn/completed` as terminal. A failed turn or premature EOF
   fails the run; request errors retain method, code, and message.
8. Capture the latest matching `thread/tokenUsage/updated` value without
   inventing fields if usage is absent.
9. On completion, close stdin and require the child to exit by the teardown
   deadline. SIGTERM/SIGKILL escalation is recorded as failed clean teardown.
   Capture repository state before the first turn, after each terminal turn,
   and after the child closes; successful and failure evidence keeps distinct
   `afterTurnSha256` and `afterCloseSha256` values. Disposable final live runs
   may opt into ignored repository paths, without recursively hashing a
   dependency tree.

Read-only sandboxing and `approvalPolicy: "never"` are separate controls.
Unexpected approval, elicitation, shell-command, patch, or file-change requests
are policy violations and receive no permissive response. The spike never calls
`thread/shellCommand`, which is outside the sandbox. Repository state is hashed
immediately before the first turn, after each terminal turn, and after the child
closes, before DiffOwl persistence. A cancellation performs `turn/interrupt`,
waits for the acknowledged interrupted terminal event within its own deadline,
then writes the wrapper artifact before the disposable live repository is
removed.

[Protocol and handshake](https://developers.openai.com/codex/app-server.md#protocol)
[thread/start](https://developers.openai.com/codex/app-server.md#start-or-resume-a-thread)
[turn/start and interrupt](https://developers.openai.com/codex/app-server.md#start-a-turn)
[message-schema generation](https://developers.openai.com/codex/app-server.md#message-schema)

## Structured-output experiment

Run both strategies over identical target, context, rules, depth, and review
semantics:

1. **Marker:** use the current `FINAL_REVIEW_JSON` prompt and parser unchanged.
2. **Output schema:** remove only the marker-format instruction, pass a strict
   JSON Schema as `turn/start.outputSchema`, then prefix the returned JSON with
   the marker in memory and feed it to the existing complete-document parser.

The in-memory marker bridge is intentional experiment debt. It proves native
schema output against the exact current validator without duplicating or moving
production policy. Both strategies retain at most three total attempts on the
same thread. One malformed finding rejects the complete document; there is no
drop-and-succeed path. Schema mode retries with a JSON-only correction prompt.

The evidence artifact records strategy, prompt hash, context hash, target,
rules, depth, attempts, and validation issues. Native schema is still followed
by DiffOwl validation; provider constraint is never treated as validation proof.
Each review has at most three total turns, including validation retries, and
exhaustion records retry/retry/failed evidence.

## Evidence artifact and failures

Each run writes a versioned, redacted JSON artifact containing:

- executable/version and generated-schema manifests/hashes;
- non-sensitive auth kind, requested/effective model and provider;
- requested sandbox/approval policy and observed thread policy;
- thread ID, all turn IDs, event order, attempts, timings, and terminal status;
- usage when observed, child PID/exit result, and teardown path;
- before-turn, after-turn, and after-close repository-state hashes (with an
  optional ignored-path policy for disposable live repositories);
- cancellation interrupt deadline, acknowledgement and total timing, terminal
  interrupted status, clean EOF close, dead PID, and the wrapper-written
  cancellation artifact;
- legacy model/session values persisted by the unchanged pipeline;
- matched-case inputs, explicit selected strategy, expected-anchor matches,
  false positives, and commands;
- serving OpenCode provenance captured around each matched review: configured
  base URL/port, listener PID, executable basename, command-line digest, and
  healthy `/global/health` version. The listener identity must remain stable.

Never store account email, tokens, environment values, full prompts, repository
contents, or unbounded stderr.

Failures are a serializable discriminated union. Required kinds are executable
missing, spawn/schema-generation failure, unauthenticated, RPC error, protocol
incompatible, policy violation, turn failed, validation exhausted, cancelled,
timeout, repository mutated, teardown failed, pipeline failed, and artifact
write failed. Partial observations stay in an append-only event log instead of
a half-populated success object.

The review timeout spans initialization, auth, thread creation, and all
turns/retries. Interrupt acknowledgement and process teardown have separate
positive deadlines, both recorded in the artifact; a timeout reports the active
phase.

## Verification map

The JSONL peer tests launch a real mock child and cover request correlation,
malformed JSONL, RPC errors, premature EOF, unknown server requests,
idempotent close, bounded stderr, and hung-child escalation.

Runner tests cover marker and schema success, validation retry then success,
three-attempt exhaustion, whole-document rejection, auth failure, effective
policy capture, failed turns, usage mapping, policy violations, repository
mutation, and cancellation through interrupt to dead PID.

The pipeline integration test uses a real temporary Git repository and real
SQLite persistence. It proves OpenCode startup is never called and that existing
filtering, durable identity, persistence, enrichment, and report rendering are
unchanged. It explicitly records the current model-provenance mismatch.

Human-gated live tests use the installed login to run both output strategies,
active-turn cancellation through `runCodexAppServerSpike`, and an isolated
unauthenticated `CODEX_HOME`. The cancellation test deletes its temporary
repository only after the wrapper has written the artifact. A matched
comparison requires `DIFFOWL_CODEX_STRATEGY=marker` or `output-schema`, runs one
seeded-positive and one clean corpus case through Codex and OpenCode with
identical rendered inputs, and wraps the real default OpenCode `ensureServer`
call to capture stable serving-process provenance before and after each review.
Two cases provide directional operational evidence only; they cannot establish
general quality parity.

## Implementation increments

Keep each increment independently green and within the repository's review
budget. Open child issues if an increment cannot remain one PR-sized change.

1. **Protocol/process seam.** Add the private JSONL peer, mock child, generated-
   schema compatibility check, and focused peer tests.
2. **Review semantics.** Add the runner state machine, two output strategies,
   retry/cancellation/repository guard, evidence types, and mock-peer tests.
3. **Pipeline and live evidence.** Add the experiment wrapper, real pipeline
   integration, guarded live/matched-case scripts, then save the redacted result
   artifact and GO/NO-GO conclusion.

Expected implementation paths:

- `src/experiments/codex-app-server/app-server-peer.ts`
- `src/experiments/codex-app-server/review-runner.ts`
- `src/experiments/codex-app-server/spike.ts`
- focused tests and `fixtures/mock-app-server.mjs` beside those modules
- `package.json` for guarded spike scripts
- this plan for the final evidence and decision

No production file under `src/opencode/`, `src/review/`, `src/state/`,
`src/config.ts`, or `src/cli.ts` changes during the spike.

## GO / NO-GO rule

Return **GO** only if all operational claims hold:

- an existing ChatGPT login completes a review with API-key environment paths
  removed and without calling OpenCode;
- at least one structured-output strategy succeeds, both are compared, and the
  recommendation proves the existing three-attempt semantics;
- the repository guard is unchanged;
- cancellation reaches acknowledged interrupt, terminal `interrupted`, clean
  EOF exit within deadline, a dead PID, and a non-null wrapper artifact with
  the complete failure evidence;
- generated schemas from the tested executable contain the stable subset used;
- both matched corpus cases complete with an explicit strategy, stable serving
  OpenCode provenance, and their directional evidence is saved.

Any failed or inconclusive operational condition is **NO-GO**. Findings quality
is recorded but cannot decide adoption from only two cases.

If NO-GO, delete the experimental source, tests, fixtures, and scripts; retain
this note and the redacted result. No config, database, CLI, or chat rollback is
required.

If GO, open separate production issues in this order:

1. move neutral execution types, prompt ownership, and complete-document
   validation/retry into `src/review/` while preserving OpenCode behavior;
2. move runtime startup/status ownership behind the execution seam;
3. promote the proven App Server peer/runner and remove the marker bridge;
4. add backend selection and durable backend/version/policy/thread/turn
   provenance;
5. dispatch chat by backend or explicitly reject unsupported sessions.

## Alternatives rejected

- **ACP:** T3's Codex path and the required lifecycle evidence use App Server
  directly; ACP adds an unrelated translation boundary.
- **Official TypeScript SDK or `codex exec --json`:** smaller, but hides the
  App Server lifecycle this issue measures.
- **Production `ReviewBackend` now:** forces unresolved config, progress,
  provenance, and chat policy before viability is known.
- **Move shared policies before the spike:** creates production churn that a
  NO-GO result would not justify.
- **Generic JSON-RPC library:** a shallow abstraction with one consumer; the
  process boundary belongs inside the experiment.
- **Long-lived daemon or sessions:** expands lifecycle and routing scope without
  helping the one-review hypothesis.
- **Trust `outputSchema` without post-validation:** weakens DiffOwl's no-silent-
  loss review-document contract.

## Implementation status (2026-08-18)

Offline experiment harness tests, lint, build, cancellation-artifact checks,
three-attempt exhaustion evidence, and repository after-close checks are
covered by the hardened implementation. Real protocol generation is green
against Codex CLI 0.147.0. Human-gated ChatGPT authentication,
marker/output-schema strategy comparison, cancellation, and matched corpus
runs have not been executed. The current decision is **NO-GO / inconclusive**
under the rule above.

Known limitations retained for the experiment:

- the repository guard excludes ignored paths by default; final disposable
  live runs opt into ignored paths without recursively hashing dependency
  trees;
- emergency interrupt and teardown cleanup can extend beyond the review
  timeout;
- the legacy persisted model field remains the requested OpenCode model while
  Codex effective-model evidence is recorded separately.

If live evidence becomes GO, production work remains ordered as listed above:
neutral execution/prompt/validation ownership, runtime startup/status ownership,
promotion of the App Server peer/runner, backend/version/policy/thread/turn
provenance, then backend dispatch or explicit unsupported-session handling.

## Open questions resolved only by the spike

- Whether the account can run the requested model through App Server.
- Whether final item and usage notifications arrive before terminal completion.
- Whether native schema mode supports DiffOwl's complete report schema reliably.
- Whether stdin EOF cleanly terminates after completion and interruption.
- Whether read-only plus denied approvals preserves all Git/index/untracked state.
- Which CLI compatibility policy is supportable beyond the tested version.
