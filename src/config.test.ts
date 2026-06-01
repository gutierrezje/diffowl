import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type DiffOwlConfig } from "./config.js";

const originalCwd = process.cwd();
let tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("config", () => {
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
    expect(await readFile(parentConfig, "utf-8")).toContain("provider/updated");
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
    expect(config.skip_doc_only).toBe(false);
  });

  it("loads skip_doc_only when set", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "skip_doc_only: true"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    const config = await loadConfig();
    expect(config.skip_doc_only).toBe(true);
  });

  it("loads valid context depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "context:", "  depth: deep"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    expect((await loadConfig()).context.depth).toBe("deep");
  });

  it("fails fast for invalid explicit values", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      "model: provider/model\nmin_confidence: noisy\n",
      "utf-8",
    );
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("min_confidence");
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
