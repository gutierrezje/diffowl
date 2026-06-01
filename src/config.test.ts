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

  it("defaults invalid min_confidence to medium", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      "model: provider/model\nmin_confidence: noisy\n",
      "utf-8",
    );
    process.chdir(root);

    const config = await loadConfig();

    expect(config.min_confidence).toBe("medium");
  });

  it("loads valid context depth and defaults invalid depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "context:", "  depth: deep"].join("\n"),
      "utf-8",
    );
    process.chdir(root);

    expect((await loadConfig()).context.depth).toBe("deep");

    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/model", "context:", "  depth: noisy"].join("\n"),
      "utf-8",
    );

    expect((await loadConfig()).context.depth).toBe("default");
  });

  it("reports malformed yaml instead of silently using defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".diffowl.yml"), "model: [broken", "utf-8");
    process.chdir(root);

    await expect(loadConfig()).rejects.toThrow("Failed to load");
  });
});
