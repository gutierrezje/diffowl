---
name: verify-diffowl-opencode
description: "Verify DiffOwl's live OpenCode server and review behavior against an exact disposable Git target. Use for OpenCode transport, server lifecycle, model/provider integration, shared review-pipeline changes, cancellation, or provider-backed hook reviews."
---

# Verify DiffOwl OpenCode

Prove the OpenCode path through the freshly built DiffOwl CLI and a server owned
by this run. Read [features/README.md](features/README.md), then only the recipes
that match the change. A valid JSON document proves protocol completion, not
review quality.

## Workflow

1. Name the affected feature IDs and the explicit `provider/model` to use. This
   path may spend model usage; do not substitute a different provider silently.
2. Create a scratch with surface `opencode`, read its evidence path, and run the
   shared doctor as described by `verify-diffowl-cli`.
3. Use the scratch's reserved port. Start OpenCode through the scratch CLI, then
   capture `server status`, `.diffowl/server.pid`, server version, CLI version,
   selected model, and the port before the review. This identity must describe
   the process that serves the request, not a separate CLI probe.
4. Drive the selected recipe with `--backend opencode --model <provider/model>`.
   Capture JSON when available, the timestamped report, state database, exit
   code, and repository state before and after. Record `effective_model` when
   OpenCode exposes it; a completed request with that field empty proves the
   requested route worked, not the provider's underlying model identity.
5. Stop the server through the scratch CLI or let the shared cleanup use only
   its recorded PID. Never stop port 4096 or kill OpenCode by process name.

## Environment and mutation guard

Provider authentication must already exist. Never capture tokens, provider
request bodies, or unrelated environment variables. Preflight model resolution
before a paid review; a catalog entry from another process is not proof that the
owned server accepts it.

All Git, config, hook, finding, report, and server mutations stay in the scratch.
Keep failed attempts as separate action directories so a later success cannot
erase the reason an earlier run failed.

## Result contract

- `VERIFIED`: the selected user path completed on the recorded binary, owned
  server, requested model route, and exact Git target with observable output and
  state;
- `NOT VERIFIED`: the aligned product contradicted the recipe; or
- `INCONCLUSIVE`: provider auth, model resolution, owned-server identity, target
  identity, cancellation timing, or model availability could not be established.

Treat a stale server, model rejection, schema/transport error, or wrapper timeout
as its own result. Do not relabel it a model-quality failure. Leave the standard
target/feature/actions/observed/artifacts/cleanup/result receipt plus server PID,
port, versions, model, session ID, review target, and report path.

Scope the verdict to transport, target, and persistence when `effective_model`
is unavailable. Keep any claim about the actual underlying model
`INCONCLUSIVE` instead of treating the requested ID as proof of execution.
