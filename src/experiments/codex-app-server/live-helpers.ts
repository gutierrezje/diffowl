import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execa } from "execa";
import { isRecord, isText, type CodexJsonObject, type CodexJsonValue } from "../../codex/types.js";
import { getServerHealth } from "../../opencode/server.js";
import type { ReviewPipelineInput } from "../../review/run.js";
import type { EffectiveReviewConfig } from "../../review/runtime-config.js";
import type { ReviewTarget } from "../../review/target.js";

export const CODEX_MODEL_ENV = "DIFFOWL_CODEX_MODEL";
export const ARTIFACT_DIR_ENV = "DIFFOWL_CODEX_ARTIFACT_DIR";

export type OpenCodeProvenance = {
  baseUrl: string;
  port: number;
  listener: {
    pid: number;
    executableBasename: string;
    commandSha256: string;
  };
  health: {
    healthy: true;
    version: string;
  };
};

export type LiveEnvironment = {
  model: string;
  artifactDirectory: string;
  codexExecutable: string;
};

export type ProcessIdentity = {
  executableBasename: string;
  commandSha256: string;
};

type WindowsProcessInfo = {
  commandLine: string;
  executablePath: string;
};

export const liveConfig: EffectiveReviewConfig = {
  model: "opencode/big-pickle",
  server: { port: 4096, auto_start: true },
  context: { depth: "default" },
  reasoning: { kind: "backend-default" },
  retention: { hook_log_kb: 1024, failed_execution_days: 14, failed_execution_limit: 200 },
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

export async function captureOpenCodeProvenance(
  port: number,
  baseUrl = `http://127.0.0.1:${port}`,
): Promise<OpenCodeProvenance> {
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new RangeError("OpenCode port must be positive");
  }
  const health = await getServerHealth(port);
  const version = health?.version?.trim() ?? "";
  if (health?.healthy !== true || version === "") {
    throw new Error("OpenCode serving process did not report a healthy version.");
  }
  const pids = await findListenerPids(port);
  if (pids.length !== 1) {
    throw new Error(`Expected exactly one OpenCode listener on port ${port}.`);
  }
  const pid = pids[0];
  if (pid === undefined) throw new Error(`OpenCode listener on port ${port} was not found.`);
  const listener = await readListenerIdentity(pid);
  return {
    baseUrl,
    port,
    listener: { pid, ...listener },
    health: { healthy: true, version },
  };
}

export function assertStableOpenCodeProvenance(
  before: OpenCodeProvenance,
  after: OpenCodeProvenance,
): void {
  if (
    before.baseUrl !== after.baseUrl ||
    before.port !== after.port ||
    before.listener.pid !== after.listener.pid ||
    before.listener.executableBasename !== after.listener.executableBasename ||
    before.listener.commandSha256 !== after.listener.commandSha256 ||
    before.health.version !== after.health.version ||
    after.health.healthy !== true
  ) {
    throw new Error("OpenCode listener identity changed during the matched review.");
  }
}

export function parseUnixListenerPids(stdout: string): number[] {
  return uniquePids(stdout.split(/\s+/));
}

export function parseWindowsListenerPids(stdout: string, port: number): number[] {
  const portSuffix = `:${port}`;
  const pids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0]?.toUpperCase() !== "TCP") continue;
    const localAddress = parts[1] ?? "";
    const state = parts[3]?.toUpperCase();
    if (state !== "LISTENING" || !localAddress.endsWith(portSuffix)) continue;
    const pid = parts[4];
    if (pid !== undefined) pids.push(pid);
  }
  return uniquePids(pids);
}

export function parsePosixProcessIdentity(commandLine: string): ProcessIdentity {
  const command = commandLine.trim();
  const firstToken = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = firstToken?.[1] ?? firstToken?.[2] ?? firstToken?.[3] ?? "";
  const executableBasename = basename(executable.replaceAll("\\", "/"));
  if (command === "" || executableBasename === "") {
    throw new Error("OpenCode listener process command was empty.");
  }
  return { executableBasename, commandSha256: hashText(command) };
}

async function findListenerPids(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    try {
      const result = await execa("netstat", ["-ano"], { timeout: 5_000 });
      return parseWindowsListenerPids(result.stdout, port);
    } catch (error) {
      throw new Error(`Unable to inspect Windows listeners: ${describeError(error)}`);
    }
  }
  try {
    const result = await execa("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { timeout: 5_000 });
    return parseUnixListenerPids(result.stdout);
  } catch (error) {
    throw new Error(`Unable to inspect Unix listeners: ${describeError(error)}`);
  }
}

async function readListenerIdentity(
  pid: number,
): Promise<Omit<OpenCodeProvenance["listener"], "pid">> {
  if (process.platform === "win32") {
    const script =
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' ` +
      "| Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    try {
      const result = await execa(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 5_000 },
      );
      const processInfo = parseWindowsProcessInfo(JSON.parse(result.stdout));
      const command = processInfo.commandLine.trim() || processInfo.executablePath.trim();
      requireOpenCodeCommand(command);
      return parsePosixProcessIdentity(command);
    } catch (error) {
      throw new Error(`Unable to inspect OpenCode process ${pid}: ${describeError(error)}`);
    }
  }
  try {
    const result = await execa("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
    requireOpenCodeCommand(result.stdout);
    return parsePosixProcessIdentity(result.stdout);
  } catch (error) {
    throw new Error(`Unable to inspect OpenCode process ${pid}: ${describeError(error)}`);
  }
}

function requireOpenCodeCommand(command: string): void {
  if (!command.toLowerCase().includes("opencode")) {
    throw new Error("listener process is not OpenCode");
  }
}

function uniquePids(values: readonly string[]): number[] {
  return [
    ...new Set(
      values
        .filter((value) => /^\d+$/.test(value))
        .map((value) => Number(value))
        .filter(isPositivePid),
    ),
  ];
}

function isPositivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseWindowsProcessInfo(cause: unknown): WindowsProcessInfo {
  const processInfo = isRecord(cause) ? cause : Array.isArray(cause) ? cause[0] : undefined;
  if (!isRecord(processInfo)) throw new Error("process query returned no row");
  const commandLine = isText(processInfo["CommandLine"]) ? processInfo["CommandLine"] : "";
  const executablePath = isText(processInfo["ExecutablePath"]) ? processInfo["ExecutablePath"] : "";
  return { commandLine, executablePath };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  config: EffectiveReviewConfig = liveConfig,
): ReviewPipelineInput {
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

export async function writeSafeJsonArtifact(
  directory: string,
  value: CodexJsonValue,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `diffowl-live-${Date.now()}-${randomUUID()}.json`);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, ...artifactRecord(value) })}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

function artifactRecord(value: CodexJsonValue): CodexJsonObject {
  return isRecord(value) ? value : { value };
}
