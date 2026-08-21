# Codex App Server evidence harness

DiffOwl's production Codex adapter lives in `src/codex`. This directory retains
the human-gated protocol, operational, and matched-comparison harnesses used to
gather evidence. These commands are skipped unless their exact opt-in flag is
set, can incur model usage and cost, and never perform login.

Codex CLI 0.147.0 is the version proven by the retained run. This is not a
blanket compatibility claim for later versions. Both the production adapter
and the harness check fresh generated TypeScript and JSON schemas before an App
Server review.

## Protocol compatibility

```bash
DIFFOWL_CODEX_PROTOCOL_LIVE=1 pnpm run spike:codex:protocol-live
```

This runs the real Codex CLI protocol generator and records only redacted hashes
and counts.

## Operational App Server run

An existing ChatGPT/Codex login is required. Choose a durable, user-owned
evidence directory; do not use a temporary directory for final evidence. The
command also captures the run log, Codex CLI version, commit, index snapshot,
and permissions. `codex login status` must succeed before the paid run.

```bash
umask 077
export DIFFOWL_CODEX_EVIDENCE_BASE=/path/to/durable/diffowl-codex-evidence
export EVIDENCE_ROOT="$DIFFOWL_CODEX_EVIDENCE_BASE/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$EVIDENCE_ROOT"
export DIFFOWL_CODEX_ARTIFACT_DIR="$EVIDENCE_ROOT/artifacts"
mkdir -p "$DIFFOWL_CODEX_ARTIFACT_DIR"
set -e
set -o pipefail
export DIFFOWL_CODEX_APP_SERVER_LIVE=1
export DIFFOWL_CODEX_MODEL=gpt-5-codex
codex login status 2>&1 | tee "$EVIDENCE_ROOT/codex-login-status.txt"
codex --version | tee "$EVIDENCE_ROOT/codex-cli-version.txt"
git rev-parse HEAD | tee "$EVIDENCE_ROOT/run-commit-sha.txt"
git status --porcelain=v1 | tee "$EVIDENCE_ROOT/git-status.txt"
git ls-files --stage | tee "$EVIDENCE_ROOT/git-index-stage.txt"
pnpm run spike:codex:live 2>&1 | tee "$EVIDENCE_ROOT/codex-live.log"
```

`DIFFOWL_CODEX_EXECUTABLE` optionally overrides the executable and defaults to
`codex`. The harness runs one native-schema review, exercises cancellation, and
checks the isolated unauthenticated path. API keys are removed at the App
Server child boundary and are never written to artifacts. A review is bounded
at three turns, including validation retries, and isolated authentication must
fail before a paid turn.

## Matched Codex/OpenCode comparison

This is directional experimentation only. It makes no parity or GO claim.

```bash
umask 077
export DIFFOWL_CODEX_EVIDENCE_BASE=/path/to/durable/diffowl-codex-evidence
export EVIDENCE_ROOT="$DIFFOWL_CODEX_EVIDENCE_BASE/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$EVIDENCE_ROOT"
export DIFFOWL_CODEX_ARTIFACT_DIR="$EVIDENCE_ROOT/artifacts"
mkdir -p "$DIFFOWL_CODEX_ARTIFACT_DIR"
set -e
set -o pipefail
export DIFFOWL_CODEX_MATCHED_LIVE=1
export DIFFOWL_CODEX_MODEL=gpt-5-codex
export DIFFOWL_OPENCODE_MODEL=provider/model
codex login status 2>&1 | tee "$EVIDENCE_ROOT/codex-login-status.txt"
codex --version | tee "$EVIDENCE_ROOT/codex-cli-version.txt"
opencode --version 2>&1 | tee "$EVIDENCE_ROOT/opencode-cli-version-supporting.txt"
git rev-parse HEAD | tee "$EVIDENCE_ROOT/run-commit-sha.txt"
git status --porcelain=v1 | tee "$EVIDENCE_ROOT/git-status.txt"
git ls-files --stage | tee "$EVIDENCE_ROOT/git-index-stage.txt"
pnpm run spike:codex:matched 2>&1 | tee "$EVIDENCE_ROOT/codex-opencode-matched.log"
```

The comparison materializes the seeded-positive `off-by-one-slice` and clean
`harmless-trim` corpus cases into separate repositories. It runs each through
the real review pipeline, compares prompt and context hashes, and writes
collision-safe mode-0600 JSON under the mode-0700 artifact directory. It also
records the serving OpenCode listener identity and health version before and
after each review. Every review is bounded at three turns, so matched mode is at
most 2 cases x 2 providers x 3 turns = 12 turns.

Hash every evidence file, including logs and version/index snapshots, and check
permissions after the harness finishes:

```bash
export CHECKSUM_MANIFEST="$EVIDENCE_ROOT.sha256"
export CHECKSUM_MANIFEST_HASH="$EVIDENCE_ROOT.sha256.sha256"
find "$EVIDENCE_ROOT" -type f -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 > "$CHECKSUM_MANIFEST"
chmod 600 "$CHECKSUM_MANIFEST"
shasum -a 256 "$CHECKSUM_MANIFEST" > "$CHECKSUM_MANIFEST_HASH"
chmod 600 "$CHECKSUM_MANIFEST_HASH"
test -z "$(find "$EVIDENCE_ROOT" -type d ! -perm 700 -print -quit)"
test -z "$(find "$EVIDENCE_ROOT" -type f ! -perm 600 -print -quit)"
```

## Normal verification

```bash
pnpm run spike:codex:test
pnpm run lint
```

Without the explicit live flags, the operational and matched tests remain
skipped. The repository guard covers tracked, staged, unstaged, selected
untracked, and ignored paths. Emergency interrupt and teardown cleanup can
extend beyond the review timeout. The unchanged legacy persistence record still
stores the requested OpenCode model while Codex evidence records the effective
Codex model separately.
