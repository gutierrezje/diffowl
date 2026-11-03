import { execa } from "execa";
import { loadConfigFromRoot, parseProjectConfig, type DiffOwlConfig, type ReviewContextDepth } from "../config.js";
import { resolveCommitRef, resolveDefaultBranchRef } from "../git/diff.js";
import { resolveSharedDiffOwlDir } from "../git/state-root.js";
import { recordPolicyAcknowledgement, type PolicyChangeTuple } from "../state/policy-acknowledgements.js";
import { reviewPolicyInput, reviewPolicySha256 } from "./coverage.js";

export interface PolicyChange extends PolicyChangeTuple {
  /** Effective policy fields that differ, so a human can see what the branch changed. */
  differences: { field: string; base: unknown; branch: unknown }[];
}

/**
 * Compares the branch's effective review policy with the policy `.diffowl.yml` defines at the
 * base commit, or null when they match. Both sides go through `reviewPolicyInput`, so every
 * field that affects review coverage is covered without listing knobs here. A base without the
 * file means the defaults. `depth` is the branch's effective depth; the base uses its own
 * configured depth, so selecting a shallower depth by flag is a policy change too.
 */
export async function comparePolicyToBase(
  projectRoot: string, baseCommit: string, branchConfig: DiffOwlConfig, depth?: ReviewContextDepth,
): Promise<PolicyChange | null> {
  const baseConfig = await loadConfigAtCommit(projectRoot, baseCommit);
  const baseInput = reviewPolicyInput(baseConfig, baseConfig.context.depth);
  const branchInput = reviewPolicyInput(branchConfig, depth ?? branchConfig.context.depth);
  const baseSha = reviewPolicySha256(baseConfig, baseInput.depth);
  const branchSha = reviewPolicySha256(branchConfig, branchInput.depth);
  if (baseSha === branchSha) return null;
  const baseFields = new Map(Object.entries(baseInput));
  const differences = Object.entries(branchInput)
    .map(([field, branch]) => ({ field, base: baseFields.get(field), branch }))
    .filter(({ base, branch }) => JSON.stringify(base) !== JSON.stringify(branch));
  return { base_commit: baseCommit, base_policy_sha256: baseSha, branch_policy_sha256: branchSha, differences };
}

/**
 * Finds the config the working tree would use at `commit`: the nearest `.diffowl.yml` walking up
 * from the project root to the repository root, matching how the project root is discovered.
 */
async function loadConfigAtCommit(projectRoot: string, commit: string): Promise<DiffOwlConfig> {
  const { stdout: top } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot });
  const { stdout: prefix } = await execa("git", ["rev-parse", "--show-prefix"], { cwd: projectRoot });
  const directories = prefix.split("/").filter(Boolean);
  for (let depth = directories.length; depth >= 0; depth--) {
    const path = [...directories.slice(0, depth), ".diffowl.yml"].join("/");
    const { stdout: listed } = await execa("git", ["ls-tree", "--name-only", commit, "--", path], { cwd: top });
    if (listed === "") continue;
    const { stdout: raw } = await execa("git", ["show", `${commit}:${path}`], { cwd: top, stripFinalNewline: false });
    return parseProjectConfig(raw, `${path} at ${commit}`).config;
  }
  return parseProjectConfig(null, `.diffowl.yml at ${commit}`).config;
}

export interface AcceptPolicyChangeOptions {
  projectRoot: string;
  base?: string;
  depth?: ReviewContextDepth;
}

export interface PolicyConfirmationIo {
  /** Both stdin and stdout are a terminal; the only thing that distinguishes a person at the keyboard. */
  interactive: boolean;
  confirm(change: PolicyChange): Promise<boolean>;
  now(): Date;
}

export type AcceptPolicyChangeResult =
  | { kind: "not-interactive" }
  | { kind: "unchanged" }
  | { kind: "declined"; change: PolicyChange }
  | { kind: "accepted"; change: PolicyChange };

export async function acceptPolicyChange(
  options: AcceptPolicyChangeOptions, io: PolicyConfirmationIo,
): Promise<AcceptPolicyChangeResult> {
  // Checked before any repository work so a non-interactive caller learns the rule immediately.
  if (!io.interactive) return { kind: "not-interactive" };
  const base = await resolveCommitRef(options.base ?? await resolveDefaultBranchRef(options.projectRoot), options.projectRoot);
  const change = await comparePolicyToBase(options.projectRoot, base, await loadConfigFromRoot(options.projectRoot), options.depth);
  if (change === null) return { kind: "unchanged" };
  if (!await io.confirm(change)) return { kind: "declined", change };
  await recordPolicyAcknowledgement(await resolveSharedDiffOwlDir(options.projectRoot), change, io.now().toISOString());
  return { kind: "accepted", change };
}
