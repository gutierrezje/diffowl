import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { removeTempDir } from "./test/helpers.js";
import { closeStateDatabase, openStateDatabase } from "./state/db.js";
import { dismissFinding } from "./state/lifecycle.js";
import { reconcileReviewFindings } from "./state/reconcile.js";
import { insertReview } from "./state/repositories/reviews.js";
import { getFindingSummary } from "./state/findings-summary.js";
import type { FindingCandidate, ReviewSeverity } from "./state/types.js";

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
  it("does not load model overrides for unrelated commands", async () => {
    const repo = await createRepo("diffowl-cli-server-model-");
    await writeFile(
      join(repo, ".diffowl", "preferences.yml"),
      "model: provider/local\nunknown: true\n",
      "utf8",
    );

    const result = await execa("node", [cliPath, "server", "status"], {
      cwd: repo,
      env: { DIFFOWL_MODEL: "invalid" },
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Config error");
  });

  it("stores the selected model locally without changing project config", async () => {
    const repo = await createRepo("diffowl-cli-model-", { localModel: false });
    const configPath = join(repo, ".diffowl.yml");
    const originalConfig = await readFile(configPath, "utf8");

    const { stdout } = await execa("node", [cliPath, "model", "provider/local"], { cwd: repo });

    expect(stdout).toContain("Model set to provider/local");
    await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
    await expect(readFile(join(repo, ".diffowl/preferences.yml"), "utf8")).resolves.toBe(
      "model: provider/local\n",
    );
  });

  it("rejects an explicitly empty model", async () => {
    const repo = await createRepo("diffowl-cli-model-empty-", { localModel: false });

    const result = await execa("node", [cliPath, "model", ""], { cwd: repo, reject: false });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid model");
  });

  it("resets the local model preference without using the legacy project model", async () => {
    const repo = await createRepo("diffowl-cli-model-reset-");
    await execa("node", [cliPath, "model", "provider/local"], { cwd: repo });

    const { stdout } = await execa("node", [cliPath, "model", "--reset"], { cwd: repo });

    expect(stdout).toContain("Local model preference reset");
    await expect(access(join(repo, ".diffowl/preferences.yml"))).rejects.toThrow();
  });

  it("requires a personal model even when legacy project config has one", async () => {
    const repo = await createRepo("diffowl-cli-model-required-", { localModel: false });

    const result = await execa("node", [cliPath, "review", "--staged"], {
      cwd: repo,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No model selected");
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

describe("diffowl findings summary", () => {
  it("surfaces a reachable open finding, then nothing once it is resolved", async () => {
    const repo = await createRepo("diffowl-cli-findings-summary-");
    await writeFile(join(repo, "README.md"), "hello\n", "utf8");
    await commitAll(repo, "initial");
    const { stdout: headCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    const { findingId } = await seedOpenFinding(repo, headCommit.trim());

    const populated = await execa("node", [cliPath, "findings", "summary"], { cwd: repo });
    expect(populated.exitCode).toBe(0);
    expect(populated.stdout).toBe(
      "DiffOwl: 1 open findings, top severity error — run `diffowl findings list`.",
    );

    // Resolve the same finding directly against state.db, then re-run: the populated and
    // resolved cases share one repo/finding to assert the transition rather than a second,
    // independent fixture (per plan action 5).
    const state = await openStateDatabase(join(repo, ".diffowl"));
    try {
      dismissFinding(state.db, findingId, { actor: "user", reason: "test: resolved" });
    } finally {
      closeStateDatabase(state);
    }

    const resolved = await execa("node", [cliPath, "findings", "summary"], { cwd: repo });
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stdout).toBe("");
  });

  it("excludes a finding whose review commit is not an ancestor of HEAD", async () => {
    const repo = await createRepo("diffowl-cli-findings-summary-unreachable-");
    await writeFile(join(repo, "README.md"), "hello\n", "utf8");
    await commitAll(repo, "initial");
    await execa("git", ["switch", "-c", "side"], { cwd: repo });
    await writeFile(join(repo, "side.md"), "side\n", "utf8");
    await commitAll(repo, "side commit");
    const { stdout: sideCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    await execa("git", ["switch", "main"], { cwd: repo });
    await seedOpenFinding(repo, sideCommit.trim());

    const result = await execa("node", [cliPath, "findings", "summary"], { cwd: repo });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("never creates .diffowl state when DiffOwl has not run", async () => {
    const repo = await mkdtemp(join(tmpdir(), "diffowl-cli-findings-summary-fresh-"));
    tempDirs.push(repo);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "hello\n", "utf8");
    await commitAll(repo, "initial");
    const diffOwlDir = join(repo, ".diffowl");

    // Asserted directly (not only through the CLI subprocess): getFindingSummary must return
    // before ever reaching withFindingDatabase/openStateDatabase when the state database file is
    // absent. An empty stdout from the CLI alone would pass even with the side effect present.
    const directSummary = await getFindingSummary(diffOwlDir, { cwd: repo });
    expect(directSummary).toEqual({
      openCount: 0,
      regressedCount: 0,
      topSeverity: null,
      inspectCommand: "diffowl findings list",
    });
    expect(existsSync(diffOwlDir)).toBe(false);

    const result = await execa("node", [cliPath, "findings", "summary"], { cwd: repo });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(join(diffOwlDir, "state.db"))).toBe(false);
    expect(existsSync(diffOwlDir)).toBe(false);
  });
});

/**
 * Seeds one review targeting `targetCommit` and one open finding observed on it, by calling
 * `insertReview` + `reconcileReviewFindings` directly against the repo's `.diffowl/state.db`
 * rather than through the (model-dependent) review pipeline.
 */
async function seedOpenFinding(
  repo: string,
  targetCommit: string,
  overrides: { severity?: ReviewSeverity; title?: string; body?: string } = {},
): Promise<{ findingId: string }> {
  const state = await openStateDatabase(join(repo, ".diffowl"));
  try {
    const review = insertReview(state.db, {
      targetKind: "commit",
      targetCommit,
      diffHash: "seed-hash",
      model: "provider/model",
      reasoning: "auto",
      depth: "default",
      sessionId: "seed-session",
      summary: "seed",
    });
    const candidate: FindingCandidate = {
      file: "src/example.ts",
      line: 1,
      severity: overrides.severity ?? "error",
      confidence: "high",
      title: overrides.title ?? "Example finding",
      body: overrides.body ?? "Example body",
    };
    const result = reconcileReviewFindings(state.db, review.id, [candidate]);
    return { findingId: result.observations[0]!.finding.id };
  } finally {
    closeStateDatabase(state);
  }
}

async function createRepo(
  prefix: string,
  options: { skipDocOnly?: boolean; localModel?: boolean } = {},
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
  if (options.localModel !== false) {
    await writeFile(join(repo, ".diffowl", "preferences.yml"), "model: provider/model\n", "utf8");
  }
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
