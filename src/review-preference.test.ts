import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { resetSharedDiffOwlDirForTests } from "./git/state-root.js";
import {
  loadReviewPreferences,
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

  it("stores discriminated model choices for every backend without overwriting any", async () => {
    const repo = await createRepo("diffowl-review-preference-both-");
    process.chdir(repo);

    await saveReviewBackendModel("opencode", "provider/local");
    await saveReviewBackendModel("codex", "gpt-5.4");
    await saveReviewBackendModel("cursor", "gpt-5.6-luna");
    const preferencePath = await saveReviewBackendPreference("cursor");

    await expect(loadReviewPreferences()).resolves.toEqual({
      kind: "current",
      selectedBackend: "cursor",
      models: [
        { backend: "opencode", model: "provider/local" },
        { backend: "codex", model: "gpt-5.4" },
        { backend: "cursor", model: "gpt-5.6-luna" },
      ],
    });
    await expect(readFile(preferencePath, "utf8")).resolves.toBe(
      [
        "backend: cursor",
        "models:",
        "  - backend: opencode",
        "    model: provider/local",
        "  - backend: codex",
        "    model: gpt-5.4",
        "  - backend: cursor",
        "    model: gpt-5.6-luna",
        "",
      ].join("\n"),
    );
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
