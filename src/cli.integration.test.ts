import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { removeTempDir } from "./test/helpers.js";

const projectRoot = join(import.meta.dirname, "..");
const cliPath = join(projectRoot, "dist/cli.js");

let tempDirs: string[] = [];

beforeAll(async () => {
  await execa("pnpm", ["run", "build"], { cwd: projectRoot });
}, 30_000);

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
  tempDirs = [];
});

describe("diffowl CLI", () => {
  it("stores the selected model locally without changing project config", async () => {
    const repo = await createRepo("diffowl-cli-model-");
    const configPath = join(repo, ".diffowl.yml");
    const originalConfig = await readFile(configPath, "utf8");

    const { stdout } = await execa("node", [cliPath, "model", "provider/local"], { cwd: repo });

    expect(stdout).toContain("Model set to provider/local");
    await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
    await expect(readFile(join(repo, ".diffowl/preferences.yml"), "utf8")).resolves.toBe(
      "model: provider/local\n",
    );
  });

  it("resets the local model preference to the project model", async () => {
    const repo = await createRepo("diffowl-cli-model-reset-");
    await execa("node", [cliPath, "model", "provider/local"], { cwd: repo });

    const { stdout } = await execa("node", [cliPath, "model", "--reset"], { cwd: repo });

    expect(stdout).toContain("provider/model");
    expect(stdout).toContain("(project)");
    await expect(access(join(repo, ".diffowl/preferences.yml"))).rejects.toThrow();
  });

  it("uses a one-off review model without changing saved model settings", async () => {
    const repo = await createRepo("diffowl-cli-review-model-", { skipDocOnly: true });
    await writeFile(join(repo, ".gitignore"), ".diffowl/\n", "utf8");
    await commitAll(repo, "initial");
    await execa("node", [cliPath, "model", "provider/local"], { cwd: repo });
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs", "model.md"), "documentation\n", "utf8");
    await commitAll(repo, "docs");
    const configBefore = await readFile(join(repo, ".diffowl.yml"), "utf8");
    const preferenceBefore = await readFile(join(repo, ".diffowl/preferences.yml"), "utf8");

    const { stdout } = await execa(
      "node",
      [cliPath, "review", "--model", "provider/command", "--format", "json"],
      { cwd: repo },
    );
    const document = JSON.parse(stdout) as { review: { model: string; status: string } };

    expect(document.review).toMatchObject({ model: "provider/command", status: "skipped" });
    await expect(readFile(join(repo, ".diffowl.yml"), "utf8")).resolves.toBe(configBefore);
    await expect(readFile(join(repo, ".diffowl/preferences.yml"), "utf8")).resolves.toBe(
      preferenceBefore,
    );
  });

  it("documents base review as an optional-value flag", async () => {
    const { stdout } = await execa("node", [cliPath, "review", "--help"]);

    expect(stdout).toContain("--base [ref]");
  });

  it.each([
    { args: ["--staged", "--commit", "HEAD"], message: "--staged and --commit" },
    { args: ["--staged", "--base"], message: "--staged and --base" },
    { args: ["--commit", "HEAD", "--base"], message: "--commit and --base" },
  ])("rejects conflicting review targets: $message", async ({ args, message }) => {
    const repo = await createRepo("diffowl-cli-conflict-");

    const result = await execa("node", [cliPath, "review", ...args], {
      cwd: repo,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Cannot use ${message} together`);
  });

  it.each([
    { label: "an explicit base", args: ["--base", "main"] },
    { label: "an auto-detected base", args: ["--base"] },
  ])("reviews committed branch changes from $label", async ({ args }) => {
    const repo = await createRepo("diffowl-cli-base-", { skipDocOnly: true });
    await writeFile(join(repo, "README.md"), "base\n", "utf8");
    await commitAll(repo, "base");
    await execa("git", ["switch", "-c", "feature"], { cwd: repo });
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs/feature.md"), "feature\n", "utf8");
    await commitAll(repo, "feature");
    const { stdout: headCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    await writeFile(join(repo, "staged.md"), "staged\n", "utf8");
    await execa("git", ["add", "staged.md"], { cwd: repo });
    await writeFile(join(repo, "unstaged.md"), "unstaged\n", "utf8");

    const { stdout } = await execa("node", [cliPath, "review", ...args, "--format", "json"], {
      cwd: repo,
    });
    const document = JSON.parse(stdout) as {
      review: {
        status: string;
        target: { kind: string; ref: string | null; commit: string | null };
        report_path: string;
      };
    };
    const report = await readFile(document.review.report_path, "utf8");

    expect(document.review.status).toBe("skipped");
    expect(document.review.target).toEqual({ kind: "base", ref: "main", commit: headCommit });
    expect(report).toContain("docs/feature.md");
    expect(report).not.toContain("staged.md");
    expect(report).not.toContain("unstaged.md");
  });

  it("reports an invalid explicit base", async () => {
    const repo = await createRepo("diffowl-cli-invalid-base-");
    await writeFile(join(repo, "README.md"), "base\n", "utf8");
    await commitAll(repo, "base");

    const result = await execa("node", [cliPath, "review", "--base", "missing"], {
      cwd: repo,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid commit ref: missing");
  });

  it("reports when a default base cannot be detected", async () => {
    const repo = await createRepo("diffowl-cli-missing-base-");
    await execa("git", ["branch", "-m", "feature"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "feature\n", "utf8");
    await commitAll(repo, "feature");

    const result = await execa("node", [cliPath, "review", "--base"], {
      cwd: repo,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Could not detect a default branch");
  });

  it("reports an empty branch diff in text mode", async () => {
    const repo = await createRepo("diffowl-cli-empty-base-text-");
    await writeFile(join(repo, "README.md"), "base\n", "utf8");
    await commitAll(repo, "base");

    const { stdout } = await execa("node", [cliPath, "review", "--base", "main"], {
      cwd: repo,
    });

    expect(stdout).toContain("No changes to review");
  });

  it("persists an empty branch diff in JSON mode", async () => {
    const repo = await createRepo("diffowl-cli-empty-base-json-");
    await writeFile(join(repo, "README.md"), "base\n", "utf8");
    await commitAll(repo, "base");
    const { stdout: headCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });

    const { stdout } = await execa(
      "node",
      [cliPath, "review", "--base", "main", "--format", "json"],
      { cwd: repo },
    );
    const document = JSON.parse(stdout) as {
      review: {
        status: string;
        skipped_reason: string | null;
        target: { kind: string; ref: string | null; commit: string | null };
      };
    };

    expect(document.review.status).toBe("skipped");
    expect(document.review.skipped_reason).toBe("empty-diff");
    expect(document.review.target).toEqual({ kind: "base", ref: "main", commit: headCommit });
  });

  it("emits skipped JSON and persists state for an empty staged diff", async () => {
    const repo = await createRepo("diffowl-cli-empty-staged-");

    const { stdout } = await execa("node", [cliPath, "review", "--staged", "--format", "json"], {
      cwd: repo,
    });

    const document = JSON.parse(stdout) as {
      review: {
        status: string;
        skipped_reason: string | null;
        target: { kind: string };
        report_path: string | null;
      };
      findings: unknown[];
    };

    expect(document.review.status).toBe("skipped");
    expect(document.review.skipped_reason).toBe("empty-diff");
    expect(document.review.target.kind).toBe("staged");
    expect(document.review.report_path).toBeNull();
    expect(document.findings).toEqual([]);
    await expect(access(join(repo, ".diffowl/state.db"))).resolves.toBeUndefined();
  });
});

async function createRepo(
  prefix: string,
  options: { skipDocOnly?: boolean } = {},
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(repo);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repo });
  await mkdir(join(repo, ".diffowl"), { recursive: true });
  await writeFile(
    join(repo, ".diffowl.yml"),
    [
      "model: provider/model",
      "server:",
      "  port: 4096",
      "  auto_start: false",
      "context:",
      "  depth: default",
      "reasoning:",
      "  effort: auto",
      "retention:",
      "  hook_log_kb: 512",
      "timeout: 300",
      "min_confidence: medium",
      "include:",
      '  - "**/*"',
      "exclude: []",
      "rules: []",
      `skip_doc_only: ${options.skipDocOnly ?? false}`,
      "verbose: false",
      "",
    ].join("\n"),
    "utf8",
  );
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await execa("git", ["add", "."], { cwd: repo });
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
    { cwd: repo },
  );
}
