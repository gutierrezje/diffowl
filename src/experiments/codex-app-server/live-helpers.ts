import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { DiffOwlConfig } from "../../config.js";
import type { ReviewTarget } from "../../review/target.js";

export const CODEX_MODEL_ENV = "DIFFOWL_CODEX_MODEL";
export const ARTIFACT_DIR_ENV = "DIFFOWL_CODEX_ARTIFACT_DIR";

export type LiveEnvironment = {
  model: string;
  artifactDirectory: string;
  codexExecutable: string;
};

export const liveConfig: DiffOwlConfig = {
  model: "opencode/big-pickle",
  server: { port: 4096, auto_start: true },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 600,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

export function requireLiveEnvironment(): LiveEnvironment {
  const model = process.env[CODEX_MODEL_ENV]?.trim() ?? "";
  const artifactDirectory = process.env[ARTIFACT_DIR_ENV]?.trim() ?? "";
  if (model === "" || model.includes("/") || artifactDirectory === "") {
    throw new Error(
      `${CODEX_MODEL_ENV} must be a bare model and ${ARTIFACT_DIR_ENV} must be nonempty.`,
    );
  }
  return {
    model,
    artifactDirectory,
    codexExecutable: process.env["DIFFOWL_CODEX_EXECUTABLE"] ?? "codex",
  };
}

export async function createStagedRepo(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `diffowl-codex-live-${label}-`));
  try {
    await execa("git", ["init", "-q"], { cwd: root, env: gitEnv() });
    await execa("git", ["config", "user.email", "live@diffowl.invalid"], { cwd: root });
    await execa("git", ["config", "user.name", "DiffOwl Live"], { cwd: root });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "example.ts"),
      "export function value(input: number): number {\n  return input + 1;\n}\n",
    );
    await execa("git", ["add", "-A"], { cwd: root });
    await execa("git", ["commit", "-qm", "baseline"], { cwd: root, env: gitEnv() });
    await writeFile(
      join(root, "src", "example.ts"),
      "export function value(input: number): number {\n  return input + 1;\n}\n\nexport const changed = true;\n",
    );
    await execa("git", ["add", "-A"], { cwd: root });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
  };
}

export function reviewInput(
  root: string,
  target: ReviewTarget = { kind: "staged" },
  config: DiffOwlConfig = liveConfig,
): {
  target: ReviewTarget;
  config: DiffOwlConfig;
  depth: "default";
  verbose: boolean;
  projectRoot: string;
  diffOwlDir: string;
  timings: [];
  persistEmptyDiff: false;
} {
  return {
    target,
    config,
    depth: "default",
    verbose: false,
    projectRoot: root,
    diffOwlDir: join(root, ".diffowl"),
    timings: [],
    persistEmptyDiff: false,
  };
}

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function writeSafeJsonArtifact(directory: string, value: unknown): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `diffowl-live-${Date.now()}-${randomUUID()}.json`);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...asRecord(value) })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
