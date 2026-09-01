import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import typescript from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSharedDiffOwlDirForTests } from "../git/state-root.js";
import * as moduleBindings from "./ast/module-bindings.js";
import {
  buildReviewContext,
  buildReviewContextFromDiff,
  loadReviewSnapshot,
  renderReviewContext,
} from "./context.js";
import type { ReviewContextSource } from "./context-source.js";
import type { DiffOwlConfig } from "../config.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const config: DiffOwlConfig = {
  server: {
    port: 4096,
    auto_start: true,
  },
  context: {
    depth: "default",
  },
  retention: {
    hook_log_kb: 1024,
  },
  gate: {
    fail_on_findings: false,
  },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

describe("loadTypescript", () => {
  it("loads DiffOwl's TypeScript dependency before a reviewed project's package", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    await mkdir(join(root, "node_modules", "typescript"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n", "utf-8");
    await writeFile(
      join(root, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "0.0.0-fake", main: "index.js" }),
      "utf-8",
    );
    await writeFile(
      join(root, "node_modules", "typescript", "index.js"),
      "module.exports = { version: '0.0.0-fake' };\n",
      "utf-8",
    );
    process.chdir(root);
    vi.resetModules();

    const { loadTypescript } = await import("./ast/load-typescript.js");

    expect(loadTypescript()?.version).toBe(typescript.version);
  });
});

describe("buildReviewContext", () => {
  it("aborts a stalled import index after ten seconds and records a timeout diagnostic", async () => {
    const root = await createGitRepository();
    vi.useFakeTimers();
    process.chdir(root);

    let unblock!: () => void;
    const blockedRead = new Promise<void>((resolve) => (unblock = resolve));
    let observedSignal: AbortSignal | undefined;
    const content = "export const value = 1;\n";
    const source: ReviewContextSource = {
      kind: "git-index",
      async read() {
        return { status: "loaded", content };
      },
      async listModules(signal) {
        observedSignal = signal;
        return new Map([["src/value.ts", "a".repeat(40)]]);
      },
      readModules(_entries, _maxBytes, _signal) {
        return (async function* () {
          await blockedRead;
          yield { path: "src/value.ts", status: "loaded", content };
        })();
      },
    };

    const contextPromise = buildReviewContextFromDiff(
      {
        root,
        target: { kind: "staged" },
        source,
        diff: {
          raw: "",
          summary: "~ src/value.ts (+1/-1)",
          files: [{ path: "src/value.ts", status: "modified", additions: 1, deletions: 1 }],
        },
      },
      config,
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(observedSignal?.aborted).toBe(true);
      unblock();
      const context = await contextPromise;

      expect(context.references).toEqual([]);
      expect(context.diagnostics).toContain(
        "TypeScript import index timed out after 10 seconds; review continued without reference context.",
      );
      expect(context.degradations).toContainEqual({
        code: "impact-index-timeout",
        count: 1,
      });
    } finally {
      unblock();
      vi.useRealTimers();
    }
  });

  it("renders merge diffs and maps resolved result lines", async () => {
    const root = await createGitRepository();
    await writeFile(join(root, "example.ts"), 'export const value = "base";\n', "utf-8");
    await commitAll(root, "base");
    await execa("git", ["branch", "side"], { cwd: root });

    await writeFile(join(root, "example.ts"), 'export const value = "main";\n', "utf-8");
    await commitAll(root, "main");
    await execa("git", ["checkout", "side"], { cwd: root });
    await writeFile(join(root, "example.ts"), 'export const value = "side";\n', "utf-8");
    await commitAll(root, "side");
    await execa("git", ["checkout", "-"], { cwd: root });
    await expect(execa("git", ["merge", "side"], { cwd: root })).rejects.toThrow();
    await writeFile(join(root, "example.ts"), 'export const value = "resolved";\n', "utf-8");
    await commitAll(root, "resolve merge");
    const { stdout: mergeCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    const { stdout: firstParent } = await execa("git", ["rev-parse", "HEAD^1"], { cwd: root });

    process.chdir(root);
    const snapshot = await loadReviewSnapshot(root, {
      kind: "commit",
      ref: mergeCommit.trim(),
    });
    const context = await buildReviewContextFromDiff(
      snapshot,
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(snapshot.baseCommit).toBe(firstParent.trim());
    expect(snapshot.targetCommit).toBe(mergeCommit.trim());
    expect(context.diff.files).toContainEqual(
      expect.objectContaining({ path: "example.ts", status: "modified" }),
    );
    expect(context.changedFiles[0]!.changedLines).toContain(1);
    expect(rendered).toMatch(
      /diff --(?:(?:cc|combined) example\.ts|git a\/example\.ts b\/example\.ts)/,
    );
    expect(rendered).toMatch(/\+{1,2}export const value = "resolved";/);
    expect(rendered).toContain("Changed AST symbols");
  });

  it("keeps first-parent source changes when a merge conflict only touches an ignored lockfile", async () => {
    const root = await createGitRepository();
    await writeFile(join(root, "pnpm-lock.yaml"), "base\n", "utf-8");
    await commitAll(root, "base");
    await execa("git", ["switch", "-c", "feature"], { cwd: root });
    await writeFile(join(root, "pnpm-lock.yaml"), "feature\n", "utf-8");
    await writeFile(join(root, "feature-only.ts"), "export const feature = true;\n", "utf-8");
    await commitAll(root, "feature");
    await execa("git", ["switch", "main"], { cwd: root });
    await writeFile(join(root, "pnpm-lock.yaml"), "main\n", "utf-8");
    await writeFile(join(root, "main-only.ts"), "export const fromMain = true;\n", "utf-8");
    await commitAll(root, "main");
    await execa("git", ["switch", "feature"], { cwd: root });
    await expect(execa("git", ["merge", "main"], { cwd: root })).rejects.toThrow();
    await writeFile(join(root, "pnpm-lock.yaml"), "resolved\n", "utf-8");
    await commitAll(root, "resolve merge");

    process.chdir(root);
    const context = await buildReviewContext({ kind: "commit", ref: "HEAD" }, config, "shallow");

    expect(context.changedFiles.map((file) => file.file.path)).toEqual(["main-only.ts"]);
    expect(context.skippedFiles.map((file) => file.path)).toEqual(["pnpm-lock.yaml"]);
  });

  it("renders synthetic diff --combined sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    await writeFile(join(root, "example.ts"), 'export const value = "resolved";\n', "utf-8");
    const raw = [
      "diff --combined example.ts",
      "index 1111111,2222222..3333333",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@@ -1,1 -1,1 +1,1 @@@",
      '- export const value = "main";',
      ' -export const value = "side";',
      '++export const value = "resolved";',
    ].join("\n");

    const context = await buildReviewContextFromDiff(
      {
        root,
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw,
          summary: "~ example.ts (+1/-2)",
          files: [{ path: "example.ts", status: "modified", additions: 1, deletions: 2 }],
        },
      },
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(context.changedFiles[0]!.changedLines).toEqual([1]);
    expect(rendered).toContain("diff --combined example.ts");
    expect(rendered).toContain('++export const value = "resolved";');
  });

  it("reads staged changed-file content from the index", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "export const value = 1;\n", "utf-8");
    await commitAll(root, "initial");

    await writeFile(join(root, "src/example.ts"), "export const value = 2;\n", "utf-8");
    await execa("git", ["add", "src/example.ts"], { cwd: root });
    await writeFile(join(root, "src/example.ts"), "export const value = 3;\n", "utf-8");

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config, "shallow");
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("value = 2");
    expect(rendered).not.toContain("value = 3");
  });

  it("reads changed-file content from the selected historical commit", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "export const value = 1;\n", "utf-8");
    await commitAll(root, "first");
    const { stdout: firstCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });

    await writeFile(join(root, "src/example.ts"), "export const value = 2;\n", "utf-8");
    await commitAll(root, "second");

    process.chdir(root);
    const context = await buildReviewContext(
      { kind: "commit", ref: firstCommit.trim() },
      config,
      "shallow",
    );
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("value = 1");
    expect(rendered).not.toContain("value = 2");
  });

  it(
    "reads related files and reference snippets from the staged index",
    { timeout: 15_000 },
    async () => {
      const root = await createGitRepository();
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src/example.ts"),
        "export function calculateTotal() {\n  return 1;\n}\n",
        "utf-8",
      );
      await writeFile(
        join(root, "src/example.test.ts"),
        "test('staged related marker', () => calculateTotal());\n",
        "utf-8",
      );
      await writeFile(
        join(root, "src/consumer.ts"),
        [
          "import { calculateTotal } from './example.js';",
          "console.log('staged reference marker', calculateTotal());",
          "",
        ].join("\n"),
        "utf-8",
      );
      await commitAll(root, "initial");

      await writeFile(
        join(root, "src/example.ts"),
        "export function calculateTotal() {\n  return 2;\n}\n",
        "utf-8",
      );
      await execa("git", ["add", "src/example.ts"], { cwd: root });
      await writeFile(
        join(root, "src/example.test.ts"),
        "test('unstaged related marker', () => calculateTotal());\n",
        "utf-8",
      );
      await writeFile(
        join(root, "src/consumer.ts"),
        [
          "import { calculateTotal } from './example.js';",
          "console.log('unstaged reference marker', calculateTotal());",
          "",
        ].join("\n"),
        "utf-8",
      );

      process.chdir(root);
      const context = await buildReviewContext({ kind: "staged" }, config);
      const rendered = renderReviewContext(context);

      expect(context.relatedFiles.map((file) => file.path)).toEqual(["src/example.test.ts"]);
      expect(rendered).toContain("staged related marker");
      expect(rendered).not.toContain("unstaged related marker");
      expect(rendered).toContain("staged reference marker");
      expect(rendered).not.toContain("unstaged reference marker");
    },
  );

  it("collects staged diff, changed file content, related tests, and reference hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await execa("git", ["init"]);
    await mkdir("src");
    await writeFile(".diffowl.yml", "model: provider/model\n", "utf-8");
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
    await mkdir(join(root, "packages", "app"), { recursive: true });
    process.chdir(join(root, "packages", "app"));

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
    expect(context.changedFiles[0]!.content).toMatchObject({
      status: "loaded",
      render: "ast-symbols",
    });
    expect(rendered).toContain("Mode: staged");
    expect(rendered).toContain("src/example.ts");
    expect(rendered).toContain("Changed AST symbols");
    expect(rendered).toContain("src/example.test.ts");
    expect(rendered).toContain("src/consumer.ts");
    expect(context.changedFiles[0]!.file.path).toBe("src/example.ts");
    expect(rendered).toContain("### Import references");
    expect(rendered).toContain("Term: calculateTotal");
    expect(rendered).toContain("console.log(calculateTotal(1));");
    expect(rendered).toContain("return value + 2");
  });

  it("builds import references from the TypeScript index without git grep", async () => {
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

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(rendered).toContain("src/consumer.ts");
    expect(rendered).toContain("### Import references");
    expect(context.diagnostics).toEqual([]);
    expect(rendered).not.toContain("Context diagnostics");
  });

  it("does not match User when an importer only names Username", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/a.ts"),
      "export interface User { id: string }\nexport type Username = string;\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/b.ts"),
      "import type { Username } from './a.js';\nexport type Login = Username;\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/a.ts"),
      "export interface User { id: number }\nexport type Username = string;\n",
      "utf-8",
    );
    await execa("git", ["add", "src/a.ts"], { cwd: root });

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config);

    expect(context.references.find((reference) => reference.term === "User")).toBeUndefined();
    expect(
      context.references.find((reference) => reference.term === "Username")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/b.ts" }));
  });

  it("resolves ESM .js specifiers to changed .tsx modules", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/button.tsx"),
      "export function Button() { return null; }\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/consumer.ts"),
      "import { Button } from './button.js';\nconsole.log(Button());\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/button.tsx"),
      "export function Button() { return 'ok'; }\n",
      "utf-8",
    );
    await execa("git", ["add", "src/button.tsx"], { cwd: root });

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config);

    expect(
      context.references.find((reference) => reference.term === "Button")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/consumer.ts" }));
  });

  it("does not attach side-effect importers to symbol terms", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 1; }\n",
      "utf-8",
    );
    await writeFile(join(root, "src/side-effect.ts"), "import './example.js';\n", "utf-8");
    await writeFile(
      join(root, "src/named.ts"),
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal());\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 2; }\n",
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"], { cwd: root });

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config);

    expect(
      context.references.find((reference) => reference.term === "calculateTotal")?.matches,
    ).toEqual([expect.objectContaining({ path: "src/named.ts" })]);
    expect(context.references.find((reference) => reference.term === "example")?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/side-effect.ts" }),
        expect.objectContaining({ path: "src/named.ts" }),
      ]),
    );
  });

  it("includes default-import sites for a named default export", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/example.ts"),
      "export default function createTotal() { return 1; }\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/consumer.ts"),
      "import createTotal from './example.js';\nconsole.log(createTotal());\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/example.ts"),
      "export default function createTotal() { return 2; }\n",
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"], { cwd: root });

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config);

    expect(
      context.references.find((reference) => reference.term === "createTotal")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/consumer.ts" }));
  });

  it("keeps later changed files when an earlier module has hundreds of importers", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src/importers"), { recursive: true });
    await writeFile(
      join(root, "src/popular.ts"),
      "export function popularFn() { return 1; }\n",
      "utf-8",
    );
    await writeFile(join(root, "src/rare.ts"), "export function rareFn() { return 1; }\n", "utf-8");
    await writeFile(
      join(root, "src/rare-consumer.ts"),
      "import { rareFn } from './rare.js';\nconsole.log(rareFn());\n",
      "utf-8",
    );
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        writeFile(
          join(root, `src/importers/c${String(index).padStart(3, "0")}.ts`),
          "import { popularFn } from '../popular.js';\nexport const n = popularFn;\n",
          "utf-8",
        ),
      ),
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/popular.ts"),
      "export function popularFn() { return 2; }\n",
      "utf-8",
    );
    await writeFile(join(root, "src/rare.ts"), "export function rareFn() { return 2; }\n", "utf-8");
    await execa("git", ["add", "src/popular.ts", "src/rare.ts"], { cwd: root });

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config);

    expect(
      context.references.find((reference) => reference.term === "rare")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/rare-consumer.ts" }));
    expect(
      context.references.find((reference) => reference.term === "popular")?.matches.length,
    ).toBeGreaterThan(0);
  }, 20_000);

  it("keeps import references when one module fails to parse", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 1; }\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/consumer.ts"),
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal());\n",
      "utf-8",
    );
    await writeFile(join(root, "src/broken.ts"), "export const broken = true;\n", "utf-8");
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 2; }\n",
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"], { cwd: root });

    const originalParse = moduleBindings.parseModuleBindings;
    const spy = vi.spyOn(moduleBindings, "parseModuleBindings").mockImplementation((input) => {
      if (input.path === "src/broken.ts") {
        throw new Error("unexpected parser failure");
      }
      return originalParse(input);
    });

    try {
      process.chdir(root);
      const context = await buildReviewContext({ kind: "staged" }, config);

      expect(context.diagnostics).toEqual(
        expect.arrayContaining([
          expect.stringContaining("src/broken.ts"),
          expect.stringContaining("unexpected parser failure"),
        ]),
      );
      expect(context.diagnostics.join("\n")).not.toContain("TypeScript import index failed");
      expect(context.degradations).toContainEqual({
        code: "impact-index-module-skipped",
        count: 1,
      });
      expect(
        context.references.find((reference) => reference.term === "calculateTotal")?.matches,
      ).toContainEqual(expect.objectContaining({ path: "src/consumer.ts" }));
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps stale importers connected across a rename", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/old-module.ts"),
      "export function calculateTotal() { return 1; }\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/consumer.ts"),
      "import { calculateTotal } from './old-module.js';\nconsole.log(calculateTotal());\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await execa("git", ["mv", "src/old-module.ts", "src/new-module.ts"], { cwd: root });

    process.chdir(root);
    const context = await buildReviewContext({ kind: "staged" }, config);

    expect(context.diff.files).toContainEqual(
      expect.objectContaining({
        path: "src/new-module.ts",
        oldPath: "src/old-module.ts",
        status: "renamed",
      }),
    );
    expect(
      context.references.find((reference) => reference.term === "new-module")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/consumer.ts" }));
  });

  it("rebuilds a corrupt blob cache entry on the next review", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 1; }\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/consumer.ts"),
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal());\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 2; }\n",
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"], { cwd: root });
    process.chdir(root);

    const first = await buildReviewContext({ kind: "staged" }, config);
    expect(first.references.some((reference) => reference.term === "calculateTotal")).toBe(true);
    const { stdout } = await execa("git", ["ls-files", "-s", "--cached", "--", "src/consumer.ts"], {
      cwd: root,
    });
    const oid = stdout.match(/^\d+ ([0-9a-f]{40}) 0\t/)?.[1];
    expect(oid).toBeDefined();
    await writeFile(join(root, ".diffowl", "impact", "blobs", `${oid}.json`), "{", "utf-8");

    const second = await buildReviewContext({ kind: "staged" }, config);

    expect(
      second.references.find((reference) => reference.term === "calculateTotal")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/consumer.ts" }));
  });

  it("rebuilds a blob cache entry produced by a different TypeScript parser", async () => {
    const root = await createGitRepository();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 1; }\n",
      "utf-8",
    );
    await writeFile(
      join(root, "src/consumer.ts"),
      "import { calculateTotal } from './example.js';\nconsole.log(calculateTotal());\n",
      "utf-8",
    );
    await commitAll(root, "initial");
    await writeFile(
      join(root, "src/example.ts"),
      "export function calculateTotal() { return 2; }\n",
      "utf-8",
    );
    await execa("git", ["add", "src/example.ts"], { cwd: root });
    process.chdir(root);

    const first = await buildReviewContext({ kind: "staged" }, config);
    expect(first.references.some((reference) => reference.term === "calculateTotal")).toBe(true);
    const { stdout } = await execa("git", ["ls-files", "-s", "--cached", "--", "src/consumer.ts"], {
      cwd: root,
    });
    const oid = stdout.match(/^\d+ ([0-9a-f]{40}) 0\t/)?.[1];
    if (!oid) throw new Error("expected cached consumer blob oid");
    const blobPath = join(root, ".diffowl", "impact", "blobs", `${oid}.json`);
    await writeFile(
      blobPath,
      `${JSON.stringify({
        version: 2,
        parserVersion: "0.0.0-mismatch",
        oid,
        exports: [],
        imports: [],
      })}\n`,
      "utf-8",
    );

    const second = await buildReviewContext({ kind: "staged" }, config);

    expect(
      second.references.find((reference) => reference.term === "calculateTotal")?.matches,
    ).toContainEqual(expect.objectContaining({ path: "src/consumer.ts" }));
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
        "import { calculateTotal } from './example.js';",
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

    expect(rendered).toContain(
      "src/large-consumer.ts:1: import { calculateTotal } from './example.js';",
    );
    expect(rendered).not.toContain("// before large reference");
    expect(rendered).not.toContain("// after large reference");
  });

  it("keeps import matches when the symbol appears after rendered text truncation", async () => {
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
      `/*${"x".repeat(260)}*/ import { calculateTotal } from './example.js';\n`,
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
    const nestedLockfiles = [
      "packages/a/package-lock.json",
      "packages/b/pnpm-lock.yaml",
      "packages/c/yarn.lock",
      "packages/d/bun.lockb",
    ];
    for (const path of nestedLockfiles) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `initial ${path}\n`, "utf-8");
    }
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
    for (const path of nestedLockfiles) {
      await writeFile(path, `nested lock marker ${path}\n`, "utf-8");
    }
    await execa("git", ["add", "."]);

    const context = await buildReviewContext({ kind: "staged" }, config);
    const rendered = renderReviewContext(context);

    expect(context.changedFiles.map((file) => file.file.path)).toContain("package.json");
    expect(context.changedFiles.map((file) => file.file.path)).not.toContain("pnpm-lock.yaml");
    expect(context.skippedFiles.map((file) => file.path)).toContain("pnpm-lock.yaml");
    expect(context.skippedFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining(nestedLockfiles),
    );
    expect(context.changedFiles.map((file) => file.file.path)).toEqual(
      expect.not.arrayContaining(nestedLockfiles),
    );
    expect(rendered).toContain("Skipped by include/exclude rules");
    expect(rendered).not.toContain("packages:");
    expect(rendered).not.toContain("nested lock marker");
  });

  it("skips oversized changed file content before rendering context", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile("src/large.txt", "x".repeat(530_000), "utf-8");

    const context = await buildReviewContextFromDiff(
      {
        root: process.cwd(),
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
    expect(context.degradations).toEqual(
      expect.arrayContaining([
        { code: "diff-output-truncated", count: 1 },
        { code: "changed-file-unavailable", count: 1 },
      ]),
    );
    expect(context.changedFiles[0]!.content).toEqual({
      status: "skipped",
      reason: expect.stringContaining("file too large for context"),
    });
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
        root: process.cwd(),
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

    expect(context.changedFiles[0]!.content).toEqual({
      status: "loaded",
      text: "",
      truncated: false,
      render: "full",
    });
    expect(rendered).not.toContain("File content skipped");
    expect(rendered).toContain("```ts\n\n```");
  });

  it("uses diff-only rendering for large added files", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);

    await mkdir("src");
    await writeFile("src/large.txt", "line\n".repeat(500), "utf-8");

    const context = await buildReviewContextFromDiff(
      {
        root: process.cwd(),
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw: [
            "diff --git a/src/large.txt b/src/large.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/large.txt",
            "@@ -0,0 +1 @@",
            "+line",
          ].join("\n"),
          summary: "+ src/large.txt (+1/-0)",
          files: [{ path: "src/large.txt", status: "added", additions: 1, deletions: 0 }],
        },
      },
      config,
      "shallow",
    );

    expect(context.changedFiles[0]!.content).toMatchObject({
      status: "loaded",
      render: "diff-only",
    });
  });

  it("represents deleted files as skipped content", async () => {
    const context = await buildReviewContextFromDiff(
      {
        root: process.cwd(),
        target: { kind: "commit", ref: "HEAD" },
        diff: {
          raw: [
            "diff --git a/src/deleted.ts b/src/deleted.ts",
            "--- a/src/deleted.ts",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-export const removed = true;",
          ].join("\n"),
          summary: "- src/deleted.ts (+0/-1)",
          files: [{ path: "src/deleted.ts", status: "deleted", additions: 0, deletions: 1 }],
        },
      },
      config,
      "shallow",
    );

    expect(context.changedFiles[0]!.content).toEqual({
      status: "skipped",
      reason: "deleted file",
    });
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
        root: process.cwd(),
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

  it("loads a branch target from the merge base and pins content to HEAD", async () => {
    const root = await createGitRepository();
    await execa("git", ["branch", "-m", "base"], { cwd: root });
    await writeFile(join(root, "example.ts"), "export const value = 'base';\n", "utf-8");
    await commitAll(root, "base");
    const { stdout: mergeBaseCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    await execa("git", ["switch", "-c", "feature"], { cwd: root });
    await writeFile(join(root, "example.ts"), "export const value = 'head';\n", "utf-8");
    await commitAll(root, "feature");
    const { stdout: headCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    await execa("git", ["switch", "base"], { cwd: root });
    await writeFile(join(root, "base-only.ts"), "export const baseOnly = true;\n", "utf-8");
    await commitAll(root, "advance base");
    const { stdout: baseCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    await execa("git", ["switch", "feature"], { cwd: root });
    await writeFile(join(root, "example.ts"), "export const value = 'dirty';\n", "utf-8");

    const snapshot = await loadReviewSnapshot(root, { kind: "base", ref: "base" });
    const context = await buildReviewContextFromDiff(snapshot, config, "shallow");

    expect(snapshot.target).toEqual({ kind: "base", ref: "base" });
    expect(snapshot.baseCommit).toBe(baseCommit);
    expect(snapshot.mergeBaseCommit).toBe(mergeBaseCommit);
    expect(snapshot.targetCommit).toBe(headCommit);
    expect(snapshot.diff.files.map((file) => file.path)).toEqual(["example.ts"]);
    expect(context.changedFiles[0]?.content).toEqual({
      status: "loaded",
      text: "export const value = 'head';\n",
      truncated: false,
      render: "ast-symbols",
    });
  });

  it("loads a branch target from a linked worktree", { timeout: 15_000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "diffowl-worktree-context-"));
    tempDirs.push(workspace);
    const primary = join(workspace, "primary");
    const linked = join(workspace, "feature-worktree");
    await execa("git", ["init", "--initial-branch=main", primary]);
    await writeFile(join(primary, "example.ts"), "export const value = 'base';\n", "utf-8");
    await commitAll(primary, "base");
    await execa("git", ["worktree", "add", "-b", "feature", linked], { cwd: primary });
    await writeFile(join(linked, "example.ts"), "export const value = 'head';\n", "utf-8");
    await commitAll(linked, "feature");
    const { stdout: linkedHead } = await execa("git", ["rev-parse", "HEAD"], { cwd: linked });
    await writeFile(join(linked, "example.ts"), "export const value = 'dirty';\n", "utf-8");

    const snapshot = await loadReviewSnapshot(linked, { kind: "base", ref: "main" });
    const context = await buildReviewContextFromDiff(snapshot, config, "shallow");

    expect(snapshot.targetCommit).toBe(linkedHead);
    expect(snapshot.diff.files.map((file) => file.path)).toEqual(["example.ts"]);
    expect(context.changedFiles[0]?.content).toMatchObject({
      status: "loaded",
      text: "export const value = 'head';\n",
    });
  });

  it("changes captured branch identity after rebasing onto an advanced base", async () => {
    const root = await createGitRepository();
    await execa("git", ["branch", "-m", "base"], { cwd: root });
    await writeFile(join(root, "example.ts"), "export const value = 'base';\n", "utf-8");
    await commitAll(root, "base");
    await execa("git", ["switch", "-c", "feature"], { cwd: root });
    await writeFile(join(root, "example.ts"), "export const value = 'feature';\n", "utf-8");
    await commitAll(root, "feature");

    const before = await loadReviewSnapshot(root, { kind: "base", ref: "base" });

    await execa("git", ["switch", "base"], { cwd: root });
    await writeFile(join(root, "base-only.ts"), "export const baseOnly = true;\n", "utf-8");
    await commitAll(root, "advance base");
    const { stdout: advancedBase } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });
    await execa("git", ["switch", "feature"], { cwd: root });
    await execa(
      "git",
      [
        "-c",
        "user.name=DiffOwl Test",
        "-c",
        "user.email=diffowl@example.test",
        "rebase",
        "base",
      ],
      { cwd: root },
    );

    const after = await loadReviewSnapshot(root, { kind: "base", ref: "base" });

    expect(after.baseCommit).toBe(advancedBase);
    expect(after.mergeBaseCommit).toBe(advancedBase);
    expect(after.targetCommit).not.toBe(before.targetCommit);
    expect(after.diff.files.map((file) => file.path)).toEqual(["example.ts"]);
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
    expect(rendered).not.toContain("Import references");
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
        root: process.cwd(),
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

  it("extracts changed AST symbols beyond the stored file-content limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);
    await mkdir("src");
    const filler = Array.from(
      { length: 150 },
      (_, index) => `const filler${index} = "${"x".repeat(90)}";`,
    );
    const functionLine = filler.length + 1;
    await writeFile(
      "src/large.ts",
      [...filler, "export function afterContextLimit() {", "  return 2;", "}", ""].join("\n"),
      "utf-8",
    );
    const context = await buildReviewContextFromDiff(
      {
        root,
        target: { kind: "staged" },
        diff: {
          raw: `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -${functionLine},3 +${functionLine},3 @@\n export function afterContextLimit() {\n-  return 1;\n+  return 2;\n }`,
          summary: "~ src/large.ts (+1/-1)",
          files: [{ path: "src/large.ts", status: "modified", additions: 1, deletions: 1 }],
        },
      },
      config,
      "shallow",
    );

    expect(context.changedFiles[0]!.content).toMatchObject({
      status: "loaded",
      truncated: true,
      text: expect.not.stringContaining("afterContextLimit"),
    });
    expect(context.changedFiles[0]!.astSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "afterContextLimit", startLine: functionLine }),
      ]),
    );
  });

  it("extracts AST symbols from JavaScript-family files", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
    tempDirs.push(root);
    process.chdir(root);
    const files = [
      ["js", "jsFunction", "export function"],
      ["jsx", "jsxFunction", "export function"],
      ["mjs", "mjsFunction", "export function"],
      ["cjs", "cjsFunction", "function"],
    ] as const;
    await mkdir("src");
    for (const [extension, name, declaration] of files) {
      await writeFile(
        `src/example.${extension}`,
        `${declaration} ${name}() {\n  return 2;\n}\n`,
        "utf-8",
      );
    }
    const context = await buildReviewContextFromDiff(
      {
        root,
        target: { kind: "staged" },
        diff: {
          raw: files
            .map(
              ([extension, name, declaration]) =>
                `diff --git a/src/example.${extension} b/src/example.${extension}\n--- a/src/example.${extension}\n+++ b/src/example.${extension}\n@@ -1,3 +1,3 @@\n ${declaration} ${name}() {\n-  return 1;\n+  return 2;\n }`,
            )
            .join("\n"),
          summary: files.map(([extension]) => `~ src/example.${extension} (+1/-1)`).join("\n"),
          files: files.map(([extension]) => ({
            path: `src/example.${extension}`,
            status: "modified" as const,
            additions: 1,
            deletions: 1,
          })),
        },
      },
      config,
      "shallow",
    );

    expect(context.diagnostics).toEqual([]);
    expect(
      context.changedFiles.flatMap((file) => file.astSymbols.map((symbol) => symbol.name)),
    ).toEqual(expect.arrayContaining(files.map(([, name]) => name)));
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
        root: process.cwd(),
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
        root: process.cwd(),
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

async function createGitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-context-"));
  tempDirs.push(root);
  await execa("git", ["init"], { cwd: root });
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
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
      message,
    ],
    { cwd: root },
  );
}
