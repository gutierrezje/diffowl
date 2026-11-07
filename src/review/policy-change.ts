import { createHash } from "node:crypto";
import { execa } from "execa";
import {
  CONFIG_FILENAME, loadConfigFromRoot, parseProjectConfig, type DiffOwlConfig, type ReviewContextDepth,
} from "../config.js";
import { resolveCommitRef, resolveDefaultBranchRef } from "../git/diff.js";
import { resolveSharedDiffOwlDir } from "../git/state-root.js";
import { recordPolicyAcknowledgement, type PolicyChangeTuple } from "../state/policy-acknowledgements.js";
import { reviewPolicyInput, reviewPolicySha256, type ReviewPolicyInput } from "./coverage.js";

/** The review policy `.diffowl.yml` defines at a commit. An unparseable file gets its own identity. */
export type BasePolicy =
  | { kind: "valid"; sha256: string; config: DiffOwlConfig }
  | { kind: "invalid"; sha256: string; problem: string };

/**
 * Reads the policy the invocation directory would use at `commit`: the nearest `.diffowl.yml`
 * walking up from `cwd` to the repository root, the same start point and rule the working tree
 * uses to discover its project root. A base without the file means the defaults. An unparseable
 * file is identified by `invalid:` plus the hash of its bytes, so a person can acknowledge it
 * but it can never equal a real policy.
 */
export async function readBasePolicy(cwd: string, commit: string): Promise<BasePolicy> {
  const { stdout } = await execa("git", ["rev-parse", "--show-toplevel", "--show-prefix"], { cwd });
  const [top = "", prefix = ""] = stdout.split("\n");
  const directories = prefix.split("/").filter(Boolean);
  for (let depth = directories.length; depth >= 0; depth--) {
    const path = [...directories.slice(0, depth), CONFIG_FILENAME].join("/");
    const { stdout: listed } = await execa("git", ["--literal-pathspecs", "ls-tree", "--name-only", commit, "--", path], { cwd: top });
    if (listed === "") continue;
    const { stdout: raw } = await execa("git", ["show", `${commit}:${path}`], { cwd: top, stripFinalNewline: false });
    try {
      const config = parseProjectConfig(raw, `${path} at ${commit}`).config;
      return { kind: "valid", sha256: reviewPolicySha256(config, config.context.depth), config };
    } catch (error) {
      const sha256 = `invalid:${createHash("sha256").update(raw).digest("hex")}`;
      return { kind: "invalid", sha256, problem: error instanceof Error ? error.message : String(error) };
    }
  }
  const config = parseProjectConfig(null, `${CONFIG_FILENAME} at ${commit}`).config;
  return { kind: "valid", sha256: reviewPolicySha256(config, config.context.depth), config };
}

/**
 * The policy on the base side of the branch policy check: the one at the merge base of `baseCommit`
 * and `head`. Readiness and `policy accept` both read it here, so an acknowledgement recorded by one
 * always describes the comparison the other makes. Comparing with the merge base rather than the
 * base tip keeps a policy edit made only on the base branch from counting as this branch's change.
 */
export async function readMergeBasePolicy(
  projectRoot: string, cwd: string, baseCommit: string, head: string,
): Promise<{ mergeBase: string; policy: BasePolicy }> {
  const { stdout: mergeBase } = await execa("git", ["merge-base", baseCommit, head], { cwd: projectRoot });
  return { mergeBase, policy: await readBasePolicy(cwd, mergeBase) };
}

/** The command a person runs to acknowledge the change; it must match what readiness was asked. */
export function policyAcceptCommand(baseCommit: string, depth?: ReviewContextDepth): string {
  return `diffowl policy accept --base ${baseCommit}${depth === undefined ? "" : ` --depth ${depth}`}`;
}

// Exhaustive on purpose: a new policy knob must be given the name users see in `.diffowl.yml`.
const POLICY_KEYS = {
  depth: "context.depth", include: "include", exclude: "exclude", rules: "rules",
  minConfidence: "min_confidence", skipDocOnly: "skip_doc_only",
} satisfies Record<Exclude<keyof ReviewPolicyInput, "version">, string>;

export interface PolicyChange extends PolicyChangeTuple {
  /** Where the branch split from the base: only edits made on the branch count as its policy change. */
  merge_base_commit: string;
  /** What the branch changed, named as in `.diffowl.yml`, so a person can judge the change. */
  differences: { field: string; base: unknown; branch: unknown }[];
}

export interface AcceptPolicyChangeOptions {
  projectRoot: string;
  /** Directory the command was invoked from; defaults to `projectRoot`. */
  cwd?: string;
  base?: string;
  depth?: ReviewContextDepth;
}

export interface PolicyConfirmationIo {
  /** Both stdin and stdout are a terminal; the only thing that distinguishes a person at the keyboard. */
  interactive: boolean;
  confirm(change: PolicyChange): Promise<boolean>;
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
  const baseCommit = await resolveCommitRef(options.base ?? await resolveDefaultBranchRef(options.projectRoot), options.projectRoot);
  const branchConfig = await loadConfigFromRoot(options.projectRoot);
  const branchInput = reviewPolicyInput(branchConfig, options.depth ?? branchConfig.context.depth);
  const branchSha = reviewPolicySha256(branchConfig, branchInput.depth);
  const { mergeBase, policy: base } = await readMergeBasePolicy(
    options.projectRoot, options.cwd ?? options.projectRoot, baseCommit, "HEAD");
  if (base.sha256 === branchSha) return { kind: "unchanged" };
  const change: PolicyChange = {
    merge_base_commit: mergeBase, base_policy_sha256: base.sha256, branch_policy_sha256: branchSha,
    differences: describeDifferences(base, branchInput),
  };
  if (!await io.confirm(change)) return { kind: "declined", change };
  await recordPolicyAcknowledgement(await resolveSharedDiffOwlDir(options.projectRoot), change);
  return { kind: "accepted", change };
}

function describeDifferences(base: BasePolicy, branchInput: ReviewPolicyInput): PolicyChange["differences"] {
  if (base.kind === "invalid") {
    return [{ field: CONFIG_FILENAME, base: `unparseable at the merge base: ${base.problem}`, branch: "parses" }];
  }
  const baseFields = new Map(Object.entries(reviewPolicyInput(base.config, base.config.context.depth)));
  const branchFields = new Map(Object.entries(branchInput));
  return Object.entries(POLICY_KEYS)
    .map(([field, key]) => ({ field: key, base: baseFields.get(field), branch: branchFields.get(field) }))
    .filter(({ base: before, branch }) => JSON.stringify(before) !== JSON.stringify(branch));
}
