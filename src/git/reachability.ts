import { execa } from "execa";
import type { Options as ExecaOptions } from "execa";

/**
 * Filters `candidates` down to the SHAs that are ancestors of (or equal to) HEAD.
 *
 * The candidate list is bounded by review count (tens), not by history length — this is why
 * `git merge-base --is-ancestor` is run once per distinct candidate instead of a single
 * `git rev-list HEAD` walk, which would scale with history length and is unbounded (D-01).
 */
export async function filterReachableCommits(
  candidates: readonly string[],
  cwd?: string,
): Promise<Set<string>> {
  const distinctCandidates = [...new Set(candidates)];

  const results = await Promise.all(
    distinctCandidates.map(async (sha) => {
      const options: ExecaOptions = { reject: false };
      if (cwd !== undefined) {
        Object.assign(options, { cwd });
      }
      const result = await execa("git", ["merge-base", "--is-ancestor", sha, "HEAD"], options);
      // exitCode 0: ancestor (reachable). exitCode 1: not an ancestor. Those are the only two
      // answers this predicate has; every fatal condition goes through git's die(), which always
      // exits 128. So 128 means "git gave up", not specifically "unknown object" — a rebased-away
      // or garbage-collected SHA, a missing repo, and an unreadable object store are
      // indistinguishable by exit code, and all are folded into "not reachable" per D-04 and the
      // isRecoverableGitLookupError precedent in git/state-root.ts. That is deliberate for a
      // fail-silent session-start path (D-17): dropping a finding is preferable to breaking the
      // hook. The throw below therefore catches only exit codes git does not otherwise produce
      // (e.g. a shell/spawn failure), so an unexpected contract change surfaces instead of
      // silently under-reporting the summary (carried forward from PR #60).
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 128) {
        throw new Error(
          `git merge-base --is-ancestor exited ${String(result.exitCode)} for ${sha}: ${result.stderr}`,
        );
      }
      return { sha, reachable: result.exitCode === 0 };
    }),
  );

  return new Set(results.filter((result) => result.reachable).map((result) => result.sha));
}
