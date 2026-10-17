# Review execution provenance

DiffOwl records execution provenance locally so two reviews can be compared
without assuming that the same requested model means the same review inputs.
`diffowl review --format json` includes the execution record; save that document
as the machine-readable evidence export. Failed reviews include the available
execution evidence when their journal was created successfully.

The operation owns the immutable Git target and captured context manifest. Each
execution belongs to that operation and records its reviewer role, optional
cohort ID, requested and effective model, terminal outcome, and evidence. Native
session, thread, turn, run, request, and message IDs are correlation identifiers.
They do not authorize reopening a conversation.

## Comparing reviews

Compare the exact base, merge base, head, target kind, and diff hash first. Then
compare context-manifest, prompt, rules, configuration, output-schema, and review
profile hashes. Context degradation codes and counts remain structured data;
they do not need to be recovered from diagnostic prose.

Prompt hashes describe the adapter's submitted prompt material. Codex uses
native structured output and developer instructions; OpenCode and Cursor use
the marker document protocol. A different prompt strategy is a different input,
even when the source diff is identical. Hashes retain identity without retaining
prompt or rule text in provenance.

Backend, effective model, runtime/adapter versions, protocol evidence,
authentication category, and enforced policy explain the execution environment.
Native IDs, timestamps, timings, usage, and retry outcomes are observations;
they are not reasons to change finding identity. This evidence does not add a
new readiness policy or make two correlated model sessions independent.

## Available runtime evidence

| Backend    | Observed facts                                                                                                                                                                                    | Limits                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex      | CLI version, generated protocol digest, ChatGPT authentication category, reported provider/model, thread and turn IDs, native JSON attempts, token usage, read-only/no-network/no-approval policy | Provider cost is unavailable. Tool names are not an independent allowlist; the sandbox and approval policy apply.                                                                |
| OpenCode   | Serving runtime version when available, adapter version, reported provider/model, session and message IDs, marker attempts, usage, actual tool allowlist and permission rejection                 | Authentication method, protocol version, OS sandbox and network restriction are not established by the adapter.                                                                  |
| Cursor SDK | SDK version, reported model, agent/run/request IDs, marker attempts, usage, configured tools and denied requests                                                                                  | SDK authentication uses an API key, including SDK-managed sign-in. The tool policy is not an OS sandbox or network boundary. Provider cost and protocol version are unavailable. |

Unknown facts are `null`. DiffOwl does not substitute a requested model alias for
a missing effective model, infer authentication from a provider name, or copy
raw runtime responses into the durable envelope. Credential values, account
identity, environment maps, repository contents, and error text do not belong
in this provenance record.

Attempt counts and the accepted attempt distinguish structured-output repair
from success on the first response. They are separate from the execution's
attempt number within its operation. Failed and cancelled executions retain
the facts observed before termination, including usage when the provider
reported it. A stable failure category distinguishes protocol, authentication,
policy, validation, provider, quota, teardown, cancellation, and timeout failures
where the adapter can identify them.

## Storage and upgrades

The additional evidence is attached to existing execution rows. Older records
keep their IDs, lifecycle history, and original provenance version. Missing
historical evidence stays unknown; opening a database does not reconstruct it
from current configuration.

The latest published database schema is 7. These additions remain in the single
unreleased migration 8 alongside readiness coverage. Released migration SQL and
checksums remain unchanged. A development database already using a different
schema-8 checksum is rejected by the existing integrity guard; it is not reset
or silently rewritten. Follow the [schema release gate](../CONTRIBUTING.md#database-schema-release-gate)
before freezing the migration for publication.
