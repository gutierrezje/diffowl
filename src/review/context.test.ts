import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { buildReviewContext, renderReviewContext } from "./context.js";
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

    const context = await buildReviewContext("staged", config);
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
    expect(rendered).toContain("src/example.ts");
    expect(rendered).toContain("Changed TypeScript AST symbols");
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
      const context = await buildReviewContext("staged", config);
      const rendered = renderReviewContext(context);

      expect(rendered).toContain("src/consumer.ts");
      expect(rendered).toContain("### Potential Call Flow");
      expect(context.diagnostics).toEqual([]);
      expect(rendered).not.toContain("Context diagnostics");
    } finally {
      process.env["PATH"] = originalPath;
    }
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

    const context = await buildReviewContext("staged", config);
    const rendered = renderReviewContext(context);

    expect(context.changedFiles.map((file) => file.file.path)).toContain("package.json");
    expect(context.changedFiles.map((file) => file.file.path)).not.toContain("pnpm-lock.yaml");
    expect(context.skippedFiles.map((file) => file.path)).toContain("pnpm-lock.yaml");
    expect(rendered).toContain("Skipped by include/exclude rules");
    expect(rendered).not.toContain("packages:");
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

    const context = await buildReviewContext("staged", config, "shallow");
    const rendered = renderReviewContext(context);

    expect(context.relatedFiles).toHaveLength(0);
    expect(context.references).toHaveLength(0);
    expect(rendered).toContain("Review depth: shallow");
    expect(rendered).toContain("Changed TypeScript AST symbols");
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

    const context = await buildReviewContext("staged", config);
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

    const context = await buildReviewContext("staged", config);
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

    const context = await buildReviewContext("staged", config);
    const symbols = context.changedFiles[0]!.symbols;

    expect(symbols).toContain("calculateTotal");
    expect(symbols).not.toContain("localTax");
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
