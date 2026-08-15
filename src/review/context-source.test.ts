import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemContextSource, createGitContextSource, toPosixGitPath } from "./context-source.js";

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
    expect([...worktreeModules]).toEqual([["src/example.ts", worktreeOid.trim()]]);
  });
});

describe("toPosixGitPath", () => {
  it("converts Windows separators to git paths", () => {
    expect(toPosixGitPath("src\\example.test.ts")).toBe("src/example.test.ts");
    expect(toPosixGitPath("src/example.test.ts")).toBe("src/example.test.ts");
  });
});
