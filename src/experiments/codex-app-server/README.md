# Codex App Server human-gated harness

These tests are deliberately skipped unless their exact opt-in flag is set. They are operational experiments, not the normal DiffOwl test suite, and they never perform login or change production OpenCode code.

## Protocol compatibility

```bash
DIFFOWL_CODEX_PROTOCOL_LIVE=1 pnpm run spike:codex:protocol-live
```

This runs the real Codex CLI protocol generator and records only redacted hashes and counts.

## Operational App Server run

An existing ChatGPT/Codex login is required. The run can incur model usage and cost.
Choose a durable, user-owned evidence directory before starting; do not use a
temporary directory for final evidence. The commands below also capture the
run log, Codex CLI version, serving OpenCode health/version where applicable,
commit, index snapshot, and permissions. `codex login status` must succeed
before the paid run.

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
if ! curl --fail --silent http://127.0.0.1:4096/global/health \
  | tee "$EVIDENCE_ROOT/opencode-health-supporting.txt"; then
  printf '%s\n' 'OpenCode server not used by Codex-only run' \
    > "$EVIDENCE_ROOT/opencode-health-supporting.txt"
fi
pnpm run spike:codex:live 2>&1 | tee "$EVIDENCE_ROOT/codex-live.log"
```

`DIFFOWL_CODEX_EXECUTABLE` optionally overrides the Codex executable; it defaults to `codex`. The harness uses `codex app-server --stdio`, runs marker and output-schema reviews, exercises cancellation, and checks the isolated unauthenticated path. API keys are removed at the App Server child boundary and are never written to artifacts.

The isolated-auth check uses a disposable empty `CODEX_HOME` and must fail
before a paid turn. A successful live run records bounded validation attempts:
each Codex review can use at most three turns, so the two operational reviews
use at most six turns total, plus one cancellation turn.

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
export DIFFOWL_CODEX_STRATEGY=marker  # exactly marker or output-schema
export DIFFOWL_OPENCODE_MODEL=provider/model
codex login status 2>&1 | tee "$EVIDENCE_ROOT/codex-login-status.txt"
codex --version | tee "$EVIDENCE_ROOT/codex-cli-version.txt"
opencode --version 2>&1 | tee "$EVIDENCE_ROOT/opencode-cli-version-supporting.txt"
git rev-parse HEAD | tee "$EVIDENCE_ROOT/run-commit-sha.txt"
git status --porcelain=v1 | tee "$EVIDENCE_ROOT/git-status.txt"
git ls-files --stage | tee "$EVIDENCE_ROOT/git-index-stage.txt"
if ! curl --fail --silent http://127.0.0.1:4096/global/health \
  | tee "$EVIDENCE_ROOT/opencode-health-supporting.txt"; then
  printf '%s\n' 'OpenCode health will be established by the matched harness' \
    > "$EVIDENCE_ROOT/opencode-health-supporting.txt"
fi
pnpm run spike:codex:matched 2>&1 | tee "$EVIDENCE_ROOT/codex-opencode-matched.log"
```

The comparison materializes the seeded-positive `off-by-one-slice` and clean `harmless-trim` corpus cases into separate repositories, runs the real review pipeline for each side, compares prompt/context hashes, and writes collision-safe mode-0600 JSON under the mode-0700 artifact directory. Matched mode requires the explicit strategy above; it records the serving OpenCode listener PID, executable basename, command digest, and `/global/health` version before and after each review and fails if that identity is unavailable or changes. The standalone `opencode --version` file is supporting CLI evidence only; only the harness's listener and healthy-server provenance establishes which process served the review. Artifacts contain case/config metadata, hashes, protocol/process evidence, usage, session/thread IDs, and finding coordinates/counts only; they exclude prompts, context, source/diff content, finding prose, environment values, account data, tokens, stderr, stacks, and causes.

Every Codex and OpenCode review is bounded at three turns, including validation
retries. Therefore matched mode is at most 2 cases × 2 providers × 3 turns =
12 turns.

Hash every evidence file, including logs and version/index snapshots, and run a
permissions check after the harness finishes:

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
if [ "$(uname -s)" = "Darwin" ]; then
  test "$(stat -f '%Lp' "$CHECKSUM_MANIFEST")" = 600
  test "$(stat -f '%Lp' "$CHECKSUM_MANIFEST_HASH")" = 600
else
  test "$(stat -c '%a' "$CHECKSUM_MANIFEST")" = 600
  test "$(stat -c '%a' "$CHECKSUM_MANIFEST_HASH")" = 600
fi
```

## Normal verification

```bash
pnpm run spike:codex:test
pnpm run lint
```

Without the explicit live flags, the operational and matched tests remain skipped.
The operational live test makes two Codex reviews (marker and `output-schema`,
each up to three turns including validation retries, for at most six turns)
plus one cancellation turn. The matched test makes two corpus cases × two
providers × up to three turns, for at most twelve turns. Isolated
authentication must fail before a paid turn. Existing ChatGPT and OpenCode
logins are required, and model usage may incur cost. The repository guard
covers tracked, staged, unstaged, and explicitly untracked paths; final live
runs opt into ignored paths only for their disposable repositories, without
recursively hashing dependency-tree contents. Emergency interrupt and teardown
cleanup can extend beyond the review timeout. The unchanged legacy persistence
record still stores the requested OpenCode model while the Codex effective
model is recorded separately. No GO decision is available until the human-gated
live and matched commands actually pass.
