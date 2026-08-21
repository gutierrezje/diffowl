import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetSharedDiffOwlDirForTests } from "./git/state-root.js";
import { loadEffectiveReviewConfig } from "./effective-config.js";
import {
  saveReviewBackendModel,
  saveReviewBackendPreference,
} from "./review-preference.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetSharedDiffOwlDirForTests();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("effective config", () => {
  it("applies command, environment, and local model precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "diffowl-effective-config-"));
    tempDirs.push(root);
    await writeFile(join(root, ".diffowl.yml"), "model: provider/project\n", "utf8");
    process.chdir(root);

    await expect(loadEffectiveReviewConfig({}, {})).rejects.toThrow(
      "No model selected for OpenCode",
    );
    await saveReviewBackendModel("opencode", "provider/local");
    expect(await loadEffectiveReviewConfig({}, {})).toMatchObject({
      config: { model: "provider/local" },
      selection: { source: { model: "local" } },
    });
    expect(
      await loadEffectiveReviewConfig({}, { DIFFOWL_MODEL: "provider/environment" }),
    ).toMatchObject({
      config: { model: "provider/environment" },
      selection: { source: { model: "environment" } },
    });
    expect(
      await loadEffectiveReviewConfig(
        { model: "provider/command" },
        { DIFFOWL_MODEL: "provider/environment" },
      ),
    ).toMatchObject({
      config: { model: "provider/command" },
      selection: { source: { model: "command" } },
    });
    await expect(loadEffectiveReviewConfig({}, { DIFFOWL_MODEL: " " })).resolves.toMatchObject({
      config: { model: "provider/local" },
      selection: { source: { model: "local" } },
    });
    await writeFile(
      join(root, ".diffowl", "preferences.yml"),
      "model: provider/local\nunknown: true\n",
      "utf8",
    );
    await expect(
      loadEffectiveReviewConfig({}, { DIFFOWL_MODEL: "provider/environment" }),
    ).resolves.toMatchObject({
      config: { model: "provider/environment" },
      selection: { source: { model: "environment" } },
    });
    await writeFile(
      join(root, ".diffowl", "preferences.yml"),
      "model: provider/local\n",
      "utf8",
    );
    await expect(loadEffectiveReviewConfig({ model: "invalid" }, {})).rejects.toThrow(
      "provider/model",
    );
  });

  it("resolves a legacy preference as OpenCode without inferring from model syntax", async () => {
    const root = await createRoot("diffowl-effective-legacy-");
    await writeFile(join(root, ".diffowl/preferences.yml"), "model: provider/legacy\n", "utf8");
    process.chdir(root);

    await expect(loadEffectiveReviewConfig()).resolves.toMatchObject({
      config: { model: "provider/legacy" },
      selection: {
        backend: "opencode",
        requestedModel: "provider/legacy",
        source: { backend: "legacy", model: "legacy" },
      },
    });
  });

  it("selects one saved backend model while preserving the other", async () => {
    const root = await createRoot("diffowl-effective-both-");
    process.chdir(root);
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendModel("codex", "gpt-5.4");
    await saveReviewBackendPreference("codex");

    await expect(loadEffectiveReviewConfig()).resolves.toMatchObject({
      config: { model: "gpt-5.4" },
      selection: {
        backend: "codex",
        requestedModel: "gpt-5.4",
        source: { backend: "local", model: "local" },
      },
    });
    await expect(loadEffectiveReviewConfig({ backend: "opencode" })).resolves.toMatchObject({
      config: { model: "provider/local" },
      selection: {
        backend: "opencode",
        requestedModel: "provider/local",
        source: { backend: "command", model: "local" },
      },
    });
  });

  it("validates a one-off model within the explicit backend", async () => {
    const root = await createRoot("diffowl-effective-command-");
    process.chdir(root);

    await expect(
      loadEffectiveReviewConfig({ backend: "codex", model: "gpt-5.4" }),
    ).resolves.toMatchObject({
      config: { model: "gpt-5.4" },
      selection: {
        backend: "codex",
        requestedModel: "gpt-5.4",
        source: { backend: "command", model: "command" },
      },
    });
    await expect(
      loadEffectiveReviewConfig({ backend: "codex", model: "provider/model" }),
    ).rejects.toThrow("Codex model must be a bare model id");
    await expect(loadEffectiveReviewConfig({ model: "gpt-5.4" })).rejects.toThrow(
      "OpenCode model must use provider/model format",
    );
  });

  it("reports the selected backend when its model is missing", async () => {
    const root = await createRoot("diffowl-effective-missing-");
    process.chdir(root);

    await expect(loadEffectiveReviewConfig()).rejects.toThrow("No model selected for OpenCode");
    await expect(loadEffectiveReviewConfig({ backend: "codex" })).rejects.toThrow(
      "No model selected for Codex",
    );
  });
});

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  await writeFile(join(root, ".diffowl.yml"), "rules: []\n", "utf8");
  await mkdir(join(root, ".diffowl"), { recursive: true });
  return root;
}
