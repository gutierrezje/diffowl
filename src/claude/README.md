# Claude Code backend

The opt-in `claude` backend invokes the installed first-party Claude Code CLI.
It uses the same thin runtime-adapter pattern as [T3 Code's Claude
integration](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/provider),
with one bounded print process per review-document attempt.

```sh
claude auth login
diffowl backend claude
diffowl model sonnet
diffowl review --staged
```

Model aliases and full Claude model ids are accepted. `diffowl reasoning` passes
the Claude CLI's `--effort` value; unsupported values fail before starting the
runtime. `DIFFOWL_CLAUDE_EXECUTABLE` selects a custom executable. Runtime discovery
uses that same executable's `--version`.

Authentication remains in Claude Code. The adapter preserves its normal home,
`CLAUDE_CONFIG_DIR`, and explicit Anthropic authentication environment variables.
It does not read credential files or implement a sign-in flow. Consult
[Anthropic's authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
for supported account modes. This adapter uses the documented
[programmatic CLI](https://code.claude.com/docs/en/headless) interface rather than
embedding the Agent SDK or managing account tokens.

## Execution and policy

The adapter requires a current Claude Code CLI supporting `--restricted`,
`--safe-mode`, `--permission-prompts`, and native JSON-schema output. Unsupported
flags fail through the CLI's diagnostic; policy is never relaxed as a fallback.

- Restricted mode confines file tools to the working directories. The available
  built-in tools are `Read`, `Glob`, and `Grep`; `StructuredOutput` is also accepted
  as the runtime's native schema-output mechanism.
- Safe mode, empty setting sources, disabled hooks, disabled ambient MCP, and
  `dontAsk` with no permission host keep repository customizations out of the
  review runtime. Admin-managed policy still applies.
- Stream initialization must advertise the expected tools and no MCP servers or
  external plugins. Unexpected tool requests reject the attempt.
- The final structured object uses DiffOwl's existing native JSON contract and
  bounded validation repair. Each repair retains the original review context.
- The final session id and observed model enter ordinary execution provenance.
  Result `modelUsage` identifies a single model; when several models ran, the
  final assistant message identifies the final generation. Ambiguous model
  provenance stays unknown. Result usage, including cached input, aggregates
  across attempts.
- One total deadline covers setup and all attempts. Cancellation and forced
  process-tree cleanup are bounded; abnormal exit or surviving descendants cannot
  produce a successful review.

Before accepting output, the existing Git repository guard compares HEAD, index,
tracked changes, and untracked content. This observes persistent Git-visible
changes; it does not prove that no transient write occurred or scan every ignored
file. Restricted tools are a runtime policy rather than an OS or network sandbox.

Offline process and CLI fixtures test transport, validation, persistence, and
failure paths. Live Claude compatibility needs a separate disposable review with
working authentication; a fake process or an authentication failure does not
establish successful provider output.
