import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { filterReachableCommits } from "./reachability.js";

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return {
    ...actual,
    execa: vi.fn(actual.execa),
  };
});

const gitIdentity = ["-c", "user.name=DiffOwl Test", "-c", "user.email=diffowl@example.test"];

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
  tempDirs = [];
});

interface GitFixture {
  root: string;
  commit: (message: string) => Promise<string>;
  currentBranch: () => Promise<string>;
}

async function createRepo(): Promise<GitFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diffowl-reachability-")));
  tempDirs.push(root);
  await execa("git", ["init"], { cwd: root });

  let fileCounter = 0;
  const commit = async (message: string): Promise<string> => {
    fileCounter++;
    await writeFile(join(root, `file-${fileCounter}.txt`), `${message}\n`, "utf-8");
    await execa("git", ["add", "."], { cwd: root });
    await execa("git", [...gitIdentity, "commit", "-m", message], { cwd: root });
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    return stdout.trim();
  };

  const currentBranch = async (): Promise<string> => {
    const { stdout } = await execa("git", ["branch", "--show-current"], { cwd: root });
    return stdout.trim();
  };

  return { root, commit, currentBranch };
}

describe("filterReachableCommits", () => {
  it("classifies commits on a linear history as reachable from HEAD", async () => {
    const { root, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");

    await expect(filterReachableCommits([a, b], root)).resolves.toEqual(new Set([a, b]));
  });

  it("excludes a sibling branch's commit until it is merged into HEAD's history", async () => {
    const { root, commit, currentBranch } = await createRepo();
    const a = await commit("A");
    const main = await currentBranch();
    await execa("git", ["checkout", "-b", "side"], { cwd: root });
    const c = await commit("C");
    await execa("git", ["checkout", main], { cwd: root });
    const b = await commit("B");

    await expect(filterReachableCommits([a, b, c], root)).resolves.toEqual(new Set([a, b]));

    await execa("git", [...gitIdentity, "merge", "--no-ff", "side", "-m", "merge side"], {
      cwd: root,
    });

    await expect(filterReachableCommits([a, b, c], root)).resolves.toEqual(new Set([a, b, c]));
  });

  it("classifies a well-formed but absent SHA as not reachable without rejecting", async () => {
    const { root, commit } = await createRepo();
    const a = await commit("A");
    const unknownSha = randomBytes(20).toString("hex");

    await expect(filterReachableCommits([a, unknownSha], root)).resolves.toEqual(new Set([a]));
  });

  it("restricts reachability to ancestors of a detached HEAD", async () => {
    const { root, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");
    await execa("git", ["checkout", "--detach", a], { cwd: root });

    await expect(filterReachableCommits([a, b], root)).resolves.toEqual(new Set([a]));
  });

  it("resolves against HEAD's current position during an in-progress rebase", async () => {
    const { root, currentBranch } = await createRepo();
    await writeFile(join(root, "conflict.txt"), "base\n", "utf-8");
    await execa("git", ["add", "."], { cwd: root });
    await execa("git", [...gitIdentity, "commit", "-m", "A"], { cwd: root });
    const a = (await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const main = await currentBranch();

    await execa("git", ["checkout", "-b", "feature"], { cwd: root });
    await writeFile(join(root, "conflict.txt"), "feature\n", "utf-8");
    await execa("git", ["add", "."], { cwd: root });
    await execa("git", [...gitIdentity, "commit", "-m", "F"], { cwd: root });
    const f = (await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

    await execa("git", ["checkout", main], { cwd: root });
    await writeFile(join(root, "conflict.txt"), "main\n", "utf-8");
    await execa("git", ["add", "."], { cwd: root });
    await execa("git", [...gitIdentity, "commit", "-m", "B"], { cwd: root });
    const b = (await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

    await execa("git", ["checkout", "feature"], { cwd: root });
    await execa("git", ["rebase", main], { cwd: root, reject: false });
    expect(
      existsSync(join(root, ".git", "rebase-merge")) || existsSync(join(root, ".git", "rebase-apply")),
    ).toBe(true);

    try {
      // D-07: no rebase-state detection exists in filterReachableCommits — ancestry is tested
      // against the literal ref HEAD, which currently points at main's tip (B); the conflicting
      // commit F has not been replayed onto it yet, so it is not reachable.
      await expect(filterReachableCommits([a, b, f], root)).resolves.toEqual(new Set([a, b]));
    } finally {
      await execa("git", ["rebase", "--abort"], { cwd: root });
    }
  });

  it("resolves against HEAD's current position during an in-progress bisect", async () => {
    const { root, commit } = await createRepo();
    const a = await commit("A");
    const b = await commit("B");
    const c = await commit("C");

    await execa("git", ["bisect", "start"], { cwd: root });
    await execa("git", ["bisect", "bad", c], { cwd: root });
    await execa("git", ["bisect", "good", a], { cwd: root });

    try {
      // D-07: no bisect-state detection exists — HEAD is currently detached at the bisect
      // midpoint (B), so only A and B are reachable; C (the bad commit) is not.
      await expect(filterReachableCommits([a, b, c], root)).resolves.toEqual(new Set([a, b]));
    } finally {
      await execa("git", ["bisect", "reset"], { cwd: root });
    }
  });

  it("propagates an unexpected git exit code as an error rather than reporting not-reachable", async () => {
    // Regression test for the carried-forward finding from PR #60 (01-01 review): a genuine git
    // failure (not a repo, unreadable object store, permission error) must not be silently
    // reported as "not reachable" — that would under-report the summary rather than surface the
    // problem. Exit 0/1/128 are the three real answers (reachable/not-ancestor/unknown-object);
    // anything else must reject.
    const { root, commit } = await createRepo();
    const a = await commit("A");

    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 2,
      stdout: "",
      stderr: "simulated git failure",
    } as never);

    await expect(filterReachableCommits([a], root)).rejects.toThrow(/exited 2/);
  });

  it("issues exactly one git subprocess per distinct candidate, independent of history length", async () => {
    // Proxy chosen: direct subprocess invocation count via a spy on execa, rather than a
    // wall-clock comparison across repo sizes. Counting invocations is the more precise and
    // deterministic signal, and it directly demonstrates the guarantee this case guards: cost
    // scales with distinct candidate count (bounded by review count), never with history length
    // (D-01's amendment over the superseded `git rev-list HEAD` walk).
    const { root, commit } = await createRepo();
    const shas: string[] = [];
    for (let i = 0; i < 40; i++) {
      shas.push(await commit(`commit-${i}`));
    }
    const candidates = [shas[0]!, shas[20]!, shas[39]!, shas[0]!]; // includes a duplicate

    vi.mocked(execa).mockClear();
    await filterReachableCommits(candidates, root);

    const mergeBaseCalls = vi
      .mocked(execa)
      .mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === "merge-base" && args[1] === "--is-ancestor",
      );
    expect(mergeBaseCalls).toHaveLength(3);
  });
}, 20_000);
