import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetSharedDiffOwlDirForTests } from "./git/state-root.js";
import { loadEffectiveReviewConfig } from "./effective-config.js";
import {
  saveReviewBackendModel,
  saveReviewBackendPreference,
  saveReviewBackendReasoning,
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
      'Legacy .diffowl.yml model "provider/project" is no longer used',
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
    ).rejects.toThrow("Failed to load");
    await writeFile(join(root, ".diffowl", "preferences.yml"), "model: provider/local\n", "utf8");
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

  it("explains when a legacy project model matches the effective model", async () => {
    const root = await createRoot("diffowl-effective-legacy-model-match-");
    await writeFile(join(root, ".diffowl.yml"), "model: provider/local\n", "utf8");
    process.chdir(root);
    await saveReviewBackendModel("opencode", "provider/local");

    await expect(loadEffectiveReviewConfig()).resolves.toMatchObject({
      warnings: [
        'Deprecated .diffowl.yml model "provider/local" is no longer read. This review selected the same model from another source, so remove model from .diffowl.yml.',
      ],
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
    await expect(
      loadEffectiveReviewConfig({}, { DIFFOWL_MODEL: "gpt-5.4-mini" }),
    ).resolves.toMatchObject({
      config: { model: "gpt-5.4-mini" },
      selection: {
        backend: "codex",
        requestedModel: "gpt-5.4-mini",
        source: { backend: "local", model: "environment" },
      },
    });
  });

  it("prefers the exact saved model reasoning over legacy project reasoning", async () => {
    const root = await createRoot("diffowl-effective-reasoning-precedence-");
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/project", "reasoning:", "  effort: legacy-value"].join("\n"),
      "utf8",
    );
    process.chdir(root);
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendReasoning("opencode", "saved-value");

    await expect(loadEffectiveReviewConfig()).resolves.toMatchObject({
      reasoning: { kind: "variant", value: "saved-value" },
      config: { reasoning: { kind: "variant", value: "saved-value" } },
      warnings: [
        'Deprecated .diffowl.yml model "provider/project" is ignored; this review uses "provider/local". To keep the legacy value as your OpenCode preference, run `diffowl backend opencode` and then `diffowl model provider/project`; then remove model from .diffowl.yml.',
        'Deprecated .diffowl.yml reasoning.effort "legacy-value" is ignored because the selected model already uses reasoning.variant "saved-value" from .diffowl/preferences.yml. Remove only the deprecated reasoning block from .diffowl.yml; run `diffowl reasoning --reset` only if you want the backend default.',
      ],
    });
  });

  it("uses legacy reasoning when the saved model does not match the selected model", async () => {
    const root = await createRoot("diffowl-effective-reasoning-scope-");
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/project", "reasoning:", "  effort: legacy-value"].join("\n"),
      "utf8",
    );
    process.chdir(root);
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendReasoning("opencode", "saved-value");

    await expect(loadEffectiveReviewConfig({ model: "provider/other" })).resolves.toMatchObject({
      config: {
        model: "provider/other",
        reasoning: { kind: "variant", value: "legacy-value" },
      },
    });

    await expect(
      loadEffectiveReviewConfig({ backend: "opencode", model: "provider/local" }),
    ).resolves.toMatchObject({
      config: {
        model: "provider/local",
        reasoning: { kind: "variant", value: "saved-value" },
      },
    });
  });

  it("describes the winning command override when legacy reasoning is present", async () => {
    const root = await createRoot("diffowl-effective-reasoning-command-");
    await writeFile(
      join(root, ".diffowl.yml"),
      ["reasoning:", "  effort: legacy-value"].join("\n"),
      "utf8",
    );
    process.chdir(root);
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendReasoning("opencode", "saved-value");

    const effective = await loadEffectiveReviewConfig({ reasoning: "thinking" });

    expect(effective.reasoning).toEqual({ kind: "variant", value: "thinking" });
    expect(effective.warnings).toEqual([
      'Deprecated .diffowl.yml reasoning.effort "legacy-value" is ignored because this review uses --reasoning "thinking". Remove the deprecated reasoning block from .diffowl.yml.',
    ]);
  });

  it("warns how to clean up an explicit auto legacy value", async () => {
    const root = await createRoot("diffowl-effective-reasoning-auto-");
    await writeFile(
      join(root, ".diffowl.yml"),
      ["model: provider/project", "reasoning:", "  effort: auto"].join("\n"),
      "utf8",
    );
    process.chdir(root);
    await saveReviewBackendModel("opencode", "provider/local");

    await expect(loadEffectiveReviewConfig()).resolves.toMatchObject({
      config: { reasoning: { kind: "backend-default" } },
      warnings: [
        'Deprecated .diffowl.yml model "provider/project" is ignored; this review uses "provider/local". To keep the legacy value as your OpenCode preference, run `diffowl backend opencode` and then `diffowl model provider/project`; then remove model from .diffowl.yml.',
        'Deprecated .diffowl.yml reasoning.effort is "auto" (the backend default). Run `diffowl reasoning --reset` to clear any local override in .diffowl/preferences.yml, then remove the deprecated reasoning block from .diffowl.yml.',
      ],
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

  it("lets an explicit backend and model bypass invalid saved preferences", async () => {
    const root = await createRoot("diffowl-effective-command-invalid-preferences-");
    await writeFile(
      join(root, ".diffowl/preferences.yml"),
      "backend: opencode\nunknown: true\n",
      "utf8",
    );
    process.chdir(root);

    const commandSelection = await loadEffectiveReviewConfig({
      backend: "codex",
      model: "gpt-5.4",
    });
    expect(commandSelection).toMatchObject({
      config: { model: "gpt-5.4", reasoning: { kind: "backend-default" } },
      selection: {
        backend: "codex",
        requestedModel: "gpt-5.4",
        source: { backend: "command", model: "command" },
      },
    });
    expect(commandSelection.warnings).toEqual([
      expect.stringContaining(
        "Invalid .diffowl/preferences.yml was ignored because backend and model were selected outside the preferences file",
      ),
    ]);

    await expect(
      loadEffectiveReviewConfig(
        { backend: "opencode" },
        { DIFFOWL_MODEL: "provider/environment" },
      ),
    ).resolves.toMatchObject({
      config: {
        model: "provider/environment",
        reasoning: { kind: "backend-default" },
      },
      selection: {
        backend: "opencode",
        requestedModel: "provider/environment",
        source: { backend: "command", model: "environment" },
      },
      warnings: [
        expect.stringContaining(
          "Invalid .diffowl/preferences.yml was ignored because backend and model were selected outside the preferences file",
        ),
      ],
    });
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
