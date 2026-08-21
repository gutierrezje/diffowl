import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProjectRoot, loadConfig, saveConfig, type DiffOwlConfig } from "./config.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("config", () => {
  it("returns the directory containing the discovered config as the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    const child = join(root, "packages", "app");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
    process.chdir(child);

    expect(await realpath(getProjectRoot())).toBe(await realpath(root));
  });

  it("saves back to the discovered parent config", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    const child = join(root, "packages", "app");
    await mkdir(child, { recursive: true });

    const parentConfig = join(root, ".diffowl.yml");
    await writeFile(
      parentConfig,
      [
        "model: provider/original",
        "server:",
        "  port: 4096",
        "  auto_start: true",
        "context:",
        "  depth: default",
        "min_confidence: low",
        "include:",
        "  - '**/*'",
        "exclude: []",
        "rules: []",
      ].join("\n"),
      "utf-8",
    );

    process.chdir(child);

    const config: DiffOwlConfig = {
      ...(await loadConfig()),
      model: "provider/updated",
    };
    const savedPath = await saveConfig(config);

    expect(await realpath(savedPath)).toBe(await realpath(parentConfig));
    expect(await readFile(parentConfig, "utf-8")).not.toContain("model:");
  });

  it("omits a transient Codex model before validating project policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    process.chdir(root);
    const config = await loadConfig();
    config.model = "gpt-5.4";

    const savedPath = await saveConfig(config);

    expect(await readFile(savedPath, "utf-8")).not.toContain("model:");
  });

  it("defaults missing optional fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".diffowl.yml"), "model: provider/model\n", "utf-8");
    process.chdir(root);

    const config = await loadConfig();

    expect(config.server.port).toBe(4096);
    expect(config.min_confidence).toBe("medium");
    expect(config.context.depth).toBe("default");
    expect(config.reasoning.effort).toBe("auto");
    expect(config.retention).toEqual({ hook_log_kb: 1024 });
    expect(config.gate).toEqual({ fail_on_findings: false });
    expect(config.skip_doc_only).toBe(false);
    expect(config.verbose).toBe(false);
  });

  it("returns independent nested defaults when no config file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    process.chdir(root);

    const first = await loadConfig();
    first.server.port = 1234;
    first.context.depth = "shallow";
    first.include.push("src/**");

    const second = await loadConfig();

    expect(second.server.port).toBe(4096);
    expect(second.context.depth).toBe("default");
    expect(second.gate.fail_on_findings).toBe(false);
    expect(second.include).toEqual(["**/*"]);
  });

  for (const effort of ["auto", "none", "minimal", "low", "medium", "high", "max", "xhigh"]) {
    it(`loads ${effort} reasoning effort`, async () => {
      const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
      tempDirs.push(root);
      await writeFile(
        join(root, ".diffowl.yml"),
        ["model: provider/model", "reasoning:", `  effort: ${effort}`].join("\n"),
        "utf-8",
      );
      process.chdir(root);

      expect((await loadConfig()).reasoning.effort).toBe(effort);
    });
  }

  it("loads boolean review output settings when set", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "skip_doc_only: true", "verbose: true"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    const config = await loadConfig();
    expect(config.skip_doc_only).toBe(true);
    expect(config.verbose).toBe(true);
  });

  it("loads an enabled review gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "gate:", "  fail_on_findings: true"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    expect((await loadConfig()).gate.fail_on_findings).toBe(true);
  });

  it("loads valid context depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "context:", "  depth: shallow"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    expect((await loadConfig()).context.depth).toBe("shallow");
  });

  it("fails fast for invalid explicit values", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      "model: provider/model\nreasoning:\n  effort: noisy\n",
      "utf-8",
    );
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("reasoning.effort");
  });

  it("fails fast for malformed nested config", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      "model: provider/model\ncontext: default\n",
      "utf-8",
    );
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("context");
  });

  it("fails fast for invalid ports and array fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "server:", "  port: 70000", "include: '**/*'"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow(/server\.port|include/);
  });

  it("loads hook log retention and rejects removed review limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    const configPath = join(root, ".diffowl.yml");
    await writeFile(
      configPath,
      ["model: provider/model", "retention:", "  reviews: 12", "  hook_log_kb: 256"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow('retention: Unrecognized key: "reviews"');

    await writeFile(
      configPath,
      ["model: provider/model", "retention:", "  hook_log_kb: 256"].join("\n"),
      "utf-8",
    );
    expect((await loadConfig()).retention).toEqual({ hook_log_kb: 256 });

    await writeFile(
      configPath,
      ["model: provider/model", "retention:", "  hook_log_kb: -1"].join("\n"),
      "utf-8",
    );
    await expect(loadConfig()).rejects.toThrow("retention.hook_log_kb");
  });

  it("fails fast for unknown config keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      "model: provider/model\nunexpected: true\n",
      "utf-8",
    );
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("unexpected");
  });

  it("fails fast for invalid model format", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".diffowl.yml"), "model: missing-provider-separator\n", "utf-8");
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("model");
  });

  it("reports malformed yaml instead of silently using defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".diffowl.yml"), "model: [broken", "utf-8");
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("Failed to load");
  });
});
