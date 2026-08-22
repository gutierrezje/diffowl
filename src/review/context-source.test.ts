import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemContextSource,
  createGitContextSource,
  toPosixGitPath,
} from "./context-source.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ReviewContextSource.listModules", () => {
  it("lists commit, index, and worktree TypeScript blobs from their own snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-source-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "src/ignored.js"), "export const ignored = true;\n", "utf8");
    await execa("git", ["add", "."], { cwd: root });
    await execa(
      "git",
      [
        "-c",
        "user.name=DiffOwl Test",
        "-c",
        "user.email=diffowl@example.test",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: root },
    );
    const { stdout: sha } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    const { stdout: commitOid } = await execa(
      "git",
      ["rev-parse", `${sha.trim()}:src/example.ts`],
      { cwd: root },
    );

    await writeFile(join(root, "src/example.ts"), "export const value = 2;\n", "utf8");
    await execa("git", ["add", "src/example.ts"], { cwd: root });
    const { stdout: indexOid } = await execa("git", ["rev-parse", ":src/example.ts"], {
      cwd: root,
    });
    await execa(
      "git",
      ["update-index", "--add", "--cacheinfo", "160000", sha.trim(), "src/linked.ts"],
      { cwd: root },
    );
    await writeFile(join(root, "src/example.ts"), "export const value = 3;\n", "utf8");
    const { stdout: worktreeOid } = await execa("git", ["hash-object", "--", "src/example.ts"], {
      cwd: root,
    });

    const commitModules = await createGitContextSource(root, {
      kind: "commit",
      sha: sha.trim(),
    }).listModules();
    const indexModules = await createGitContextSource(root, { kind: "staged" }).listModules();
    const worktreeModules = await createFilesystemContextSource(root).listModules();

    expect([...commitModules]).toEqual([["src/example.ts", commitOid.trim()]]);
    expect([...indexModules]).toEqual([["src/example.ts", indexOid.trim()]]);
    expect(indexModules.has("src/linked.ts")).toBe(false);
    expect([...worktreeModules]).toEqual([["src/example.ts", worktreeOid.trim()]]);
  });
});

describe("ReviewContextSource.readModules", () => {
  it("reads multiple Git blobs in one bulk operation and skips oversized or missing blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-source-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });
    await mkdir(join(root, "src"));
    const small = Buffer.from("export const marker = 'small';\0tail\n", "utf8");
    const large = Buffer.from("x".repeat(129), "utf8");
    await writeFile(join(root, "src/small.ts"), small);
    await writeFile(join(root, "src/large.ts"), large);
    await execa("git", ["add", "."], { cwd: root });

    const oid = async (path: string) =>
      (await execa("git", ["rev-parse", `:${path}`], { cwd: root })).stdout.trim();
    const smallOid = await oid("src/small.ts");
    const largeOid = await oid("src/large.ts");
    const source = createGitContextSource(root, { kind: "staged" });
    const reads = [];
    const tracePath = join(root, "trace2.json");
    const previousTrace = process.env["GIT_TRACE2_EVENT"];
    try {
      process.env["GIT_TRACE2_EVENT"] = tracePath;
      for await (const result of source.readModules(
        new Map([
          ["src/small.ts", smallOid],
          ["src/large.ts", largeOid],
          ["src/missing.ts", "0".repeat(40)],
        ]),
        128,
        new AbortController().signal,
      )) {
        reads.push(result);
      }
    } finally {
      if (previousTrace === undefined) delete process.env["GIT_TRACE2_EVENT"];
      else process.env["GIT_TRACE2_EVENT"] = previousTrace;
    }

    expect((await readFile(tracePath, "utf8")).match(/"event":"start".*"cat-file"/g)).toHaveLength(
      1,
    );

    expect(reads).toEqual([
      { path: "src/small.ts", status: "loaded", content: small.toString("utf8") },
      {
        path: "src/large.ts",
        status: "skipped",
        reason: expect.stringContaining("file too large for context"),
      },
      {
        path: "src/missing.ts",
        status: "skipped",
        reason: expect.stringContaining("Git object unavailable"),
      },
    ]);
  });

  it("does not emit an unhandled rejection when aborted while a read is paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-source-"));
    tempDirs.push(root);
    await execa("git", ["init"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/first.ts"), "export const first = true;\n", "utf8");
    await writeFile(join(root, "src/second.ts"), "x".repeat(1024 * 1024), "utf8");
    await execa("git", ["add", "."], { cwd: root });
    const oid = async (path: string) =>
      (await execa("git", ["rev-parse", `:${path}`], { cwd: root })).stdout.trim();
    const entries = new Map([
      ["src/first.ts", await oid("src/first.ts")],
      ["src/second.ts", await oid("src/second.ts")],
    ]);
    const controller = new AbortController();
    const iterator = createGitContextSource(root, { kind: "staged" })
      .readModules(entries, 128, controller.signal)
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({
      path: "src/first.ts",
      status: "loaded",
      content: "export const first = true;\n",
    });

    const unhandled: Parameters<NodeJS.UnhandledRejectionListener>[0][] = [];
    const onUnhandled: NodeJS.UnhandledRejectionListener = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});

describe("toPosixGitPath", () => {
  it("converts Windows separators to git paths", () => {
    expect(toPosixGitPath("src\\example.test.ts")).toBe("src/example.test.ts");
    expect(toPosixGitPath("src/example.test.ts")).toBe("src/example.test.ts");
  });
});
