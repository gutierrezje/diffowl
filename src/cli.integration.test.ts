import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  it("emits skipped JSON and persists state for an empty staged diff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "diffowl-cli-empty-staged-"));
    tempDirs.push(repo);

    await execa("git", ["init"], { cwd: repo });
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
        "skip_doc_only: false",
        "verbose: false",
        "",
      ].join("\n"),
      "utf8",
    );

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
