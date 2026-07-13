import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetSharedDiffOwlDirForTests } from "./git/state-root.js";
import { saveModelPreference } from "./model-preference.js";
import { loadEffectiveConfig } from "./effective-config.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("effective config", () => {
  it("applies command, environment, local, and project model precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-effective-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".diffowl.yml"), "model: provider/project\n", "utf8");
    process.chdir(root);

    expect(await loadEffectiveConfig(undefined, {})).toMatchObject({
      config: { model: "provider/project" },
      modelSource: "project",
    });
    await saveModelPreference("provider/local");
    expect(await loadEffectiveConfig(undefined, {}, { ignoreLocal: true })).toMatchObject({
      config: { model: "provider/project" },
      modelSource: "project",
    });
    expect(await loadEffectiveConfig(undefined, {})).toMatchObject({
      config: { model: "provider/local" },
      modelSource: "local",
    });
    expect(
      await loadEffectiveConfig(undefined, { DIFFOWL_MODEL: "provider/environment" }),
    ).toMatchObject({
      config: { model: "provider/environment" },
      modelSource: "environment",
    });
    expect(
      await loadEffectiveConfig("provider/command", { DIFFOWL_MODEL: "provider/environment" }),
    ).toMatchObject({ config: { model: "provider/command" }, modelSource: "command" });
    await expect(loadEffectiveConfig(undefined, { DIFFOWL_MODEL: " " })).resolves.toMatchObject({
      config: { model: "provider/local" },
      modelSource: "local",
    });
    await writeFile(
      join(root, ".diffowl", "preferences.yml"),
      "model: provider/local\nunknown: true\n",
      "utf8",
    );
    await expect(
      loadEffectiveConfig(undefined, { DIFFOWL_MODEL: "provider/environment" }),
    ).resolves.toMatchObject({
      config: { model: "provider/environment" },
      modelSource: "environment",
    });
    await expect(loadEffectiveConfig("invalid", {})).rejects.toThrow("provider/model");
  });
});
