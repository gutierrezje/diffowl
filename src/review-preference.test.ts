import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { resetSharedDiffOwlDirForTests } from "./git/state-root.js";
import {
  loadReviewPreferences,
  resetReviewBackendModel,
  resetReviewBackendPreference,
  resetReviewBackendReasoning,
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

describe("review preferences", () => {
  it("loads a legacy model-only preference as an explicit OpenCode selection", async () => {
    const repo = await createRepo("diffowl-review-preference-legacy-");
    await writeFile(join(repo, ".diffowl/preferences.yml"), "model: provider/legacy\n", "utf8");
    process.chdir(repo);

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "legacy",
      selectedBackend: "opencode",
      models: [{ backend: "opencode", model: "provider/legacy" }],
    });
  });

  it.each([
    {
      operation: "saving a backend",
      mutate: () => saveReviewBackendPreference("codex"),
      expected: {
        kind: "current",
        selectedBackend: "codex",
        models: [{ backend: "opencode", model: "provider/legacy" }],
      },
      serialized: "backend: codex\nmodels:\n  - backend: opencode\n    model: provider/legacy\n",
    },
    {
      operation: "saving another backend model",
      mutate: () => saveReviewBackendModel("codex", "gpt-5.4"),
      expected: {
        kind: "current",
        models: [
          { backend: "opencode", model: "provider/legacy" },
          { backend: "codex", model: "gpt-5.4" },
        ],
      },
      serialized:
        "models:\n  - backend: opencode\n    model: provider/legacy\n  - backend: codex\n    model: gpt-5.4\n",
    },
    {
      operation: "saving reasoning",
      mutate: () => saveReviewBackendReasoning("opencode", "thinking"),
      expected: {
        kind: "current",
        models: [
          {
            backend: "opencode",
            model: "provider/legacy",
            reasoning: { variant: "thinking" },
          },
        ],
      },
      serialized:
        "models:\n  - backend: opencode\n    model: provider/legacy\n    reasoning:\n      variant: thinking\n",
    },
  ])("migrates a legacy preference when $operation", async ({ mutate, expected, serialized }) => {
    const repo = await createRepo("diffowl-review-preference-migrate-");
    const path = join(repo, ".diffowl/preferences.yml");
    await writeFile(path, "model: provider/legacy\n", "utf8");
    process.chdir(repo);

    await mutate();

    await expect(loadReviewPreferences()).resolves.toEqual(expected);
    await expect(readFile(path, "utf8")).resolves.toBe(serialized);
  });

  it.each([
    { operation: "resetting the backend", mutate: () => resetReviewBackendPreference() },
    { operation: "resetting another model", mutate: () => resetReviewBackendModel("codex") },
    { operation: "resetting reasoning", mutate: () => resetReviewBackendReasoning("opencode") },
  ])("migrates a legacy preference when $operation", async ({ mutate }) => {
    const repo = await createRepo("diffowl-review-preference-migrate-reset-");
    const path = join(repo, ".diffowl/preferences.yml");
    await writeFile(path, "model: provider/legacy\n", "utf8");
    process.chdir(repo);

    await mutate();

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      models: [{ backend: "opencode", model: "provider/legacy" }],
    });
    await expect(readFile(path, "utf8")).resolves.toBe(
      "models:\n  - backend: opencode\n    model: provider/legacy\n",
    );
  });

  it("removes the preference file when resetting the only legacy model", async () => {
    const repo = await createRepo("diffowl-review-preference-migrate-empty-");
    const path = join(repo, ".diffowl/preferences.yml");
    await writeFile(path, "model: provider/legacy\n", "utf8");
    process.chdir(repo);

    await resetReviewBackendModel("opencode");

    await expect(loadReviewPreferences()).resolves.toEqual({ kind: "none", models: [] });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores discriminated model choices for both backends without overwriting either", async () => {
    const repo = await createRepo("diffowl-review-preference-both-");
    process.chdir(repo);

    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendModel("codex", "gpt-5.4");
    const preferencePath = await saveReviewBackendPreference("codex");

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      selectedBackend: "codex",
      models: [
        { backend: "opencode", model: "provider/local" },
        { backend: "codex", model: "gpt-5.4" },
      ],
    });
    await expect(readFile(preferencePath, "utf8")).resolves.toBe(
      [
        "backend: codex",
        "models:",
        "  - backend: opencode",
        "    model: provider/local",
        "  - backend: codex",
        "    model: gpt-5.4",
        "",
      ].join("\n"),
    );
  });

  it("keeps a Claude model preference independent and in canonical backend order", async () => {
    const repo = await createRepo("diffowl-review-preference-claude-");
    process.chdir(repo);

    await saveReviewBackendModel("claude", "claude-sonnet-4-5-20250929");
    await saveReviewBackendModel("cursor", "composer-2.5");
    await saveReviewBackendModel("codex", "gpt-5.4");
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendPreference("claude");

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      selectedBackend: "claude",
      models: [
        { backend: "opencode", model: "provider/local" },
        { backend: "codex", model: "gpt-5.4" },
        { backend: "cursor", model: "composer-2.5" },
        { backend: "claude", model: "claude-sonnet-4-5-20250929" },
      ],
    });
  });

  it("resets the explicit backend to the OpenCode default without deleting saved models", async () => {
    const repo = await createRepo("diffowl-review-preference-reset-");
    process.chdir(repo);
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendModel("codex", "gpt-5.4");
    await saveReviewBackendPreference("codex");

    await resetReviewBackendPreference();

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      models: [
        { backend: "opencode", model: "provider/local" },
        { backend: "codex", model: "gpt-5.4" },
      ],
    });
  });

  it("stores and resets an arbitrary reasoning variant on the selected backend model", async () => {
    const repo = await createRepo("diffowl-review-preference-reasoning-");
    process.chdir(repo);
    await saveReviewBackendModel("opencode", "provider/local");

    await saveReviewBackendReasoning("opencode", "thinking");

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      models: [
        {
          backend: "opencode",
          model: "provider/local",
          reasoning: { variant: "thinking" },
        },
      ],
    });
    await expect(readFile(join(repo, ".diffowl/preferences.yml"), "utf8")).resolves.toContain(
      "reasoning:\n      variant: thinking",
    );

    await resetReviewBackendReasoning("opencode");

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      models: [{ backend: "opencode", model: "provider/local" }],
    });
  });

  it("persists auto as an opaque backend-native reasoning variant", async () => {
    const repo = await createRepo("diffowl-review-preference-auto-");
    process.chdir(repo);
    await saveReviewBackendModel("opencode", "provider/local");

    await saveReviewBackendReasoning("opencode", "auto");

    await expect(loadReviewPreferences()).resolves.toMatchObject({
      models: [
        {
          backend: "opencode",
          model: "provider/local",
          reasoning: { variant: "auto" },
        },
      ],
    });
  });

  it("clears a backend reasoning override when its model changes", async () => {
    const repo = await createRepo("diffowl-review-preference-model-change-");
    process.chdir(repo);
    await saveReviewBackendModel("opencode", "provider/old");
    await saveReviewBackendReasoning("opencode", "thinking");

    await saveReviewBackendModel("opencode", "provider/new");

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      models: [{ backend: "opencode", model: "provider/new" }],
    });
  });

  it("preserves reasoning when the selected model is saved again unchanged", async () => {
    const repo = await createRepo("diffowl-review-preference-same-model-");
    process.chdir(repo);
    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendReasoning("opencode", "thinking");

    await saveReviewBackendModel("opencode", "provider/local");

    await expect(loadReviewPreferences()).resolves.toMatchObject({
      models: [
        {
          backend: "opencode",
          model: "provider/local",
          reasoning: { variant: "thinking" },
        },
      ],
    });
  });

  it("shares backend and model preferences between linked worktrees", async () => {
    const repo = await createRepo("diffowl-review-preference-worktree-");
    await execa("git", ["add", ".diffowl.yml"], { cwd: repo });
    await execa(
      "git",
      [
        "-c",
        "user.name=DiffOwl Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "init",
      ],
      { cwd: repo },
    );
    const worktree = join(dirname(repo), `${basename(repo)}-worktree`);
    await execa("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: repo });
    tempDirs.push(worktree);

    process.chdir(worktree);
    await saveReviewBackendModel("codex", "gpt-5.4");
    await saveReviewBackendPreference("codex");
    resetSharedDiffOwlDirForTests();
    process.chdir(repo);

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      selectedBackend: "codex",
      models: [{ backend: "codex", model: "gpt-5.4" }],
    });
    await expect(readFile(join(repo, ".diffowl/preferences.yml"), "utf8")).resolves.toContain(
      "backend: codex",
    );
  });

  it("rejects unknown keys and duplicate backend model selections", async () => {
    const repo = await createRepo("diffowl-review-preference-strict-");
    process.chdir(repo);
    await writeFile(
      join(repo, ".diffowl/preferences.yml"),
      "model: provider/local\nunknown: true\n",
      "utf8",
    );
    await expect(loadReviewPreferences()).rejects.toThrow("Unrecognized key");

    await writeFile(
      join(repo, ".diffowl/preferences.yml"),
      [
        "models:",
        "  - backend: codex",
        "    model: gpt-5.4",
        "  - backend: codex",
        "    model: gpt-5.4-mini",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(loadReviewPreferences()).rejects.toThrow("duplicate codex model preference");
  });
});

async function createRepo(prefix: string): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(repo);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repo });
  await writeFile(join(repo, ".diffowl.yml"), "rules: []\n", "utf8");
  await mkdir(join(repo, ".diffowl"), { recursive: true });
  return repo;
}
