import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { buildReviewContext, buildReviewContextFromDiff, renderReviewContext } from "./context.js";
import type { DiffOwlConfig } from "../config.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const config: DiffOwlConfig = {
  model: "provider/model",
  server: {
    port: 4096,
    auto_start: true,
  },
  context: {
    depth: "default",
  },
  reasoning: {
    effort: "auto",
  },
  retention: {
    hook_log_kb: 1024,
  },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

describe("buildReviewContext", () => {
  it("collects staged diff, changed file content, related tests, and reference hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await writeFile(
      "src/example.test.ts",
      "import { calculateTotal } from './example.js';\n",
      "utf-8",
    );
    await writeFile(
      "src/consumer.ts",
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal(1));\n",
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(context.diff.files).toHaveLength(1);
    expect(context.changedFiles[0]!.symbols).toContain("calculateTotal");
    expect(context.changedFiles[0]!.changedLines).toContain(2);
    expect(context.changedFiles[0]!.astSymbols[0]!).toMatchObject({
      name: "calculateTotal",
      kind: "function",
      startLine: 1,
      endLine: 3,
    });
    expect(rendered).toContain("Mode: staged");
    expect(rendered).toContain("src/example.ts");
    expect(rendered).toContain("Changed AST symbols");
    expect(rendered).toContain("src/example.test.ts");
    expect(rendered).toContain("src/consumer.ts");
    expect(rendered).toContain("### Potential Call Flow");
    expect(rendered).toContain("Term: calculateTotal");
    expect(rendered).toContain("console.log(calculateTotal(1));");
    expect(rendered).toContain("return value + 2");
  });

  it("uses git grep for reference search without requiring ripgrep", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await writeFile(
      "src/consumer.ts",
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal(1));\n",
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const originalPath = process.env["PATH"];
    process.env["PATH"] = await makeReferenceSearchPath(root);
    try {
      const context = await buildReviewContext({ kind: "staged" }, config);
      const rendered = renderReviewContext(context);

      expect(rendered).toContain("src/consumer.ts");
      expect(rendered).toContain("### Potential Call Flow");
      expect(context.diagnostics).toEqual([]);
      expect(rendered).not.toContain("Context diagnostics");
    } finally {
      process.env["PATH"] = originalPath;
    }
  });

  it("skips snippets for large reference files while keeping line hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await writeFile(
      "src/large-consumer.ts",
      [
        "// before large reference",
        "x".repeat(270_000),
        "console.log(calculateTotal(1));",
        "// after large reference",
      ].join("\n"),
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("src/large-consumer.ts:3: console.log(calculateTotal(1));");
    expect(rendered).not.toContain("// before large reference");
    expect(rendered).not.toContain("// after large reference");
  });

  it("keeps reference matches when the search term appears after rendered text truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await writeFile(
      "src/long-line-consumer.ts",
      `${"x".repeat(260)} console.log(calculateTotal(1));\n`,
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("src/long-line-consumer.ts:1:");
  });

  it("skips lockfiles when building prompt context", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await writeFile("package.json", '{"name":"fixture"}\n', "utf-8");
    await writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n", "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile("package.json", '{"name":"fixture","version":"1.0.0"}\n', "utf-8");
    await writeFile(
      "pnpm-lock.yaml",
      ["lockfileVersion: '9.0'", "packages:", "  /large:", "    resolution: {}"].join("\n"),
      "utf-8",
    );
    await execa("git", ["add", "."]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(context.changedFiles.map((file) => file.file.path)).toContain("package.json");
    expect(context.changedFiles.map((file) => file.file.path)).not.toContain("pnpm-lock.yaml");
    expect(context.skippedFiles.map((file) => file.path)).toContain("pnpm-lock.yaml");
    expect(rendered).toContain("Skipped by include/exclude rules");
    expect(rendered).not.toContain("packages:");
  });

  it("skips oversized changed file content before rendering context", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile("src/large.txt", "x".repeat(530_000), "utf-8");

    const context = await buildReviewContextFromDiff(
      {
        target: { kind: "staged" },
        diff: {
          raw: [
            "diff --git a/src/large.txt b/src/large.txt",
            "--- a/src/large.txt",
            "+++ b/src/large.txt",
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
          ].join("\n"),
          summary: "~ src/large.txt (+1/-1)",
          files: [{ path: "src/large.txt", status: "modified", additions: 1, deletions: 1 }],
          diagnostics: ["diff truncated"],
        },
      },
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(context.diagnostics).toEqual(["diff truncated"]);
    expect(context.changedFiles[0]!.content).toBeUndefined();
    expect(context.changedFiles[0]!.skippedReason).toContain("file too large for context");
    expect(rendered).toContain("Context diagnostics");
    expect(rendered).toContain("diff truncated");
    expect(rendered).toContain("File content skipped: file too large for context");
  });

  it("keeps empty changed files as successfully loaded content", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile("src/empty.ts", "", "utf-8");

    const context = await buildReviewContextFromDiff(
      {
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw: [
            "diff --git a/src/empty.ts b/src/empty.ts",
            "--- a/src/empty.ts",
            "+++ b/src/empty.ts",
            "@@ -1 +0,0 @@",
            "-export const removed = true;",
          ].join("\n"),
          summary: "~ src/empty.ts (+0/-1)",
          files: [{ path: "src/empty.ts", status: "modified", additions: 0, deletions: 1 }],
        },
      },
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(context.changedFiles[0]!.content).toBe("");
    expect(context.changedFiles[0]!.skippedReason).toBeUndefined();
    expect(rendered).not.toContain("File content skipped");
    expect(rendered).toContain("```ts\n\n```");
  });

  it("builds commit mode context from an explicit diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );

    const context = await buildReviewContextFromDiff(
      {
        target: { kind: "commit", ref: "feature~1" },
        diff: {
          raw: [
            "diff --git a/src/example.ts b/src/example.ts",
            "--- a/src/example.ts",
            "+++ b/src/example.ts",
            "@@ -1,3 +1,3 @@",
            " export function calculateTotal(value: number) {",
            "-  return value + 1;",
            "+  return value + 2;",
            " }",
          ].join("\n"),
          summary: "~ src/example.ts (+1/-1)",
          files: [{ path: "src/example.ts", status: "modified", additions: 1, deletions: 1 }],
        },
      },
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(context.target).toEqual({ kind: "commit", ref: "feature~1" });
    expect(context.changedFiles[0]!.file.path).toBe("src/example.ts");
    expect(context.changedFiles[0]!.changedLines).toEqual([2]);
    expect(rendered).toContain("Mode: commit");
    expect(rendered).toContain("return value + 2");
  });

  it("loads an explicit commit target by its ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await writeFile("first.txt", "first\n", "utf-8");
    await execa("git", ["add", "first.txt"]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "first",
    ]);
    const { stdout: firstCommit } = await execa("git", ["rev-parse", "HEAD"]);

    await writeFile("second.txt", "second\n", "utf-8");
    await execa("git", ["add", "second.txt"]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "second",
    ]);

    const target = { kind: "commit", ref: firstCommit } as const;
    const context = await buildReviewContext(target, config, "shallow");

    expect(context.target).toEqual(target);
    expect(context.diff.files.map((file) => file.path)).toEqual(["first.txt"]);
  });

  it("loads and renders the last commit target", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await writeFile("latest.txt", "latest\n", "utf-8");
    await execa("git", ["add", "latest.txt"]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "latest",
    ]);

    const context = await buildReviewContext({ kind: "last-commit" }, config, "shallow");
    const rendered = renderReviewContext(context);

    expect(context.target).toEqual({ kind: "last-commit" });
    expect(context.diff.files.map((file) => file.path)).toEqual(["latest.txt"]);
    expect(rendered).toContain("Mode: last-commit");
  });

  it("renders a smaller shallow context without related files or references", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await writeFile(
      "src/example.test.ts",
      "import { calculateTotal } from './example.js';\n",
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      ["export function calculateTotal(value: number) {", "  return value + 2;", "}", ""].join(
        "\n",
      ),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const context = await buildReviewContext({ kind: "staged" }, config, "shallow");
    const rendered = renderReviewContext(context);

    expect(context.relatedFiles).toHaveLength(0);
    expect(context.references).toHaveLength(0);
    expect(rendered).toContain("Review depth: shallow");
    expect(rendered).toContain("Changed AST symbols");
    expect(rendered).not.toContain("Related Test Files");
    expect(rendered).not.toContain("Potential Call Flow");
  });

  it("summarizes consecutive changed lines as ranges for added files", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await writeFile("README.md", "# Fixture\n", "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await mkdir("docs");
    await writeFile(
      "docs/large.md",
      Array.from({ length: 189 }, (_, index) => `Line ${index + 1}`).join("\n"),
      "utf-8",
    );
    await execa("git", ["add", "docs/large.md"]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("Changed lines: 1-189");
    expect(rendered).toContain("Full file content omitted because the diff already shows");
    expect(rendered).not.toContain("Changed lines: 1, 2, 3");
  });

  it("omits large non-TypeScript file content when a small part changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    const originalReadme = [
      "# Fixture",
      "",
      ...Array.from({ length: 160 }, (_, index) => `Stable documentation line ${index + 1}`),
    ].join("\n");
    await writeFile("README.md", originalReadme, "utf-8");
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    const updatedReadme = originalReadme.replace(
      "Stable documentation line 80",
      "Updated documentation line 80",
    );
    await writeFile("README.md", updatedReadme, "utf-8");
    await execa("git", ["add", "README.md"]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("Updated documentation line 80");
    expect(rendered).toContain("Full file content omitted because the diff already shows");
    expect(rendered).not.toContain("Stable documentation line 1\nStable documentation line 2");
  });

  it("does not list block-scoped const declarations as file symbols", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(
      "src/example.ts",
      [
        "export function calculateTotal(value: number) {",
        "  const localTax = 1;",
        "  return value + localTax;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execa("git", ["add", "."]);
    await execa("git", [
      "-c",
      "user.name=DiffOwl Test",
      "-c",
      "user.email=diffowl@example.test",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(
      "src/example.ts",
      [
        "export function calculateTotal(value: number) {",
        "  const localTax = 2;",
        "  return value + localTax;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const symbols = context.changedFiles[0]!.symbols;

    expect(symbols).toContain("calculateTotal");
    expect(symbols).not.toContain("localTax");
  });

  it("labels top-level variable declarations by their TypeScript keyword", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile(
      "src/example.ts",
      ["export const fixed = 1;", "export let mutable = 2;", "export var legacy = 3;", ""].join(
        "\n",
      ),
      "utf-8",
    );

    const context = await buildReviewContextFromDiff(
      {
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw: [
            "diff --git a/src/example.ts b/src/example.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/example.ts",
            "@@ -0,0 +1,3 @@",
            "+export const fixed = 1;",
            "+export let mutable = 2;",
            "+export var legacy = 3;",
          ].join("\n"),
          summary: "+ src/example.ts (+3/-0)",
          files: [{ path: "src/example.ts", status: "added", additions: 3, deletions: 0 }],
        },
      },
      config,
      "shallow",
    );

    expect(context.changedFiles[0]!.astSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixed", kind: "const" }),
        expect.objectContaining({ name: "mutable", kind: "let" }),
        expect.objectContaining({ name: "legacy", kind: "var" }),
      ]),
    );
  });

  it("diagnoses unsupported code ASTs without warning for documentation files", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile(
      "src/example.py",
      "def calculate_total(value):\n    return value + 2\n",
      "utf-8",
    );
    await writeFile("README.md", "# Fixture\n\nUpdated docs.\n", "utf-8");

    const context = await buildReviewContextFromDiff(
      {
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw: [
            "diff --git a/src/example.py b/src/example.py",
            "--- a/src/example.py",
            "+++ b/src/example.py",
            "@@ -1,2 +1,2 @@",
            " def calculate_total(value):",
            "-    return value + 1",
            "+    return value + 2",
            "diff --git a/README.md b/README.md",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1,3 +1,3 @@",
            " # Fixture",
            "",
            "-Old docs.",
            "+Updated docs.",
          ].join("\n"),
          summary: "~ src/example.py (+1/-1)\n~ README.md (+1/-1)",
          files: [
            { path: "src/example.py", status: "modified", additions: 1, deletions: 1 },
            { path: "README.md", status: "modified", additions: 1, deletions: 1 },
          ],
        },
      },
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(context.diagnostics).toEqual(["Reviewing from diff and file context only."]);
    expect(rendered).toContain("Context diagnostics");
    expect(rendered).toContain("Reviewing from diff and file context only.");
    expect(rendered).not.toContain("Changed AST symbols");
  });

  it("does not classify shell files as C headers by suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await writeFile("script.sh", "echo hello\n", "utf-8");

    const context = await buildReviewContextFromDiff(
      {
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw: [
            "diff --git a/script.sh b/script.sh",
            "--- a/script.sh",
            "+++ b/script.sh",
            "@@ -1 +1 @@",
            "-echo goodbye",
            "+echo hello",
          ].join("\n"),
          summary: "~ script.sh (+1/-1)",
          files: [{ path: "script.sh", status: "modified", additions: 1, deletions: 1 }],
        },
      },
      config,
      "shallow",
    );

    expect(context.diagnostics).toEqual([]);
  });
});

async function makeReferenceSearchPath(root: string): Promise<string> {
  const gitPath = await resolveCommandPath("git");
  const binDir = join(root, "test-bin");
  await mkdir(binDir);

  if (process.platform === "win32") {
    await writeFile(join(binDir, "git.cmd"), `@"${gitPath}" %*\r\n`, "utf-8");
    await writeFile(
      join(binDir, "rg.cmd"),
      "@echo ripgrep forced failure 1>&2\r\n@exit /b 2\r\n",
      "utf-8",
    );
  } else {
    const gitShim = join(binDir, "git");
    const rgShim = join(binDir, "rg");
    await writeFile(
      gitShim,
      `#!/bin/sh\nexec '${gitPath.replaceAll("'", "'\\''")}' "$@"\n`,
      "utf-8",
    );
    await writeFile(rgShim, "#!/bin/sh\necho ripgrep forced failure >&2\nexit 2\n", "utf-8");
    await chmod(gitShim, 0o755);
    await chmod(rgShim, 0o755);
  }

  return binDir;
}

async function resolveCommandPath(command: string): Promise<string> {
  const executable = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execa(executable, [command]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]!;
}
