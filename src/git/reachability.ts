import { execa } from "execa";

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
      const result = await execa("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
        reject: false,
        ...(cwd ? { cwd } : {}),
      });
      // exitCode 0: ancestor (reachable). exitCode 1: not an ancestor. exitCode 128: unknown
      // object (rebased away or garbage-collected) — treated as not reachable rather than as a
      // failure, per D-04 and the isRecoverableGitLookupError precedent in git/state-root.ts.
      // Any other exit code is a genuine git failure (not a repo, unreadable object store,
      // permission error) and must not be silently reported as "not reachable" — that would
      // under-report the summary rather than surface the problem (carried forward from PR #60).
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
