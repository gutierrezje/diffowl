import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensureDiffOwlDir, getDiffOwlDir } from "../config.js";
import { BoundaryValueSchema, type BoundaryValue } from "./wire.js";

const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_WAIT_MS = 3000;
const MAX_RETRIES = 10;
const PORT_RELEASE_WAIT_MS = 5000;
const PORT_RELEASE_POLL_MS = 200;

const ServerHealthResponseSchema = z
  .object({
    healthy: BoundaryValueSchema.optional(),
    version: BoundaryValueSchema.optional(),
  })
  .passthrough();
const ProcessErrorSchema = z.object({ code: BoundaryValueSchema.optional() }).passthrough();

export interface ServerDependencies {
  fetch: (input: string, init?: { signal: AbortSignal }) => Promise<ServerResponse>;
  execa: (command: string, args?: string[], options?: ServerCommandOptions) => ServerCommandResult;
  existsSync: (path: string) => boolean;
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  writeFile: (path: string, data: string, encoding: "utf-8") => Promise<void>;
  unlink: (path: string) => Promise<void>;
  ensureDiffOwlDir: () => Promise<string>;
  getDiffOwlDir: () => string;
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
}

type ServerResponse = { ok: boolean; json?: () => Promise<BoundaryValue> };
type ServerCommandOptions = {
  timeout?: number;
  detached?: boolean;
  stdio?: "ignore";
  cleanup?: boolean;
};
type ServerCommandResult = Promise<{ stdout: string | undefined }> & {
  pid?: number;
  unref?: () => void;
};

const defaultDependencies: ServerDependencies = {
  fetch: (input, init) => fetch(input, init),
  execa: (command, args, options) => execa(command, args, options),
  existsSync: (path) => existsSync(path),
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
  unlink: (path) => unlink(path),
  ensureDiffOwlDir: () => ensureDiffOwlDir(),
  getDiffOwlDir: () => getDiffOwlDir(),
  kill: (pid, signal) => process.kill(pid, signal),
};

export type ServerHealth = {
  healthy: boolean;
  version?: string;
};

/**
 * Fetch OpenCode server health, including the running server version when reported.
 */
export async function getServerHealth(
  port: number,
  dependencies: ServerDependencies = defaultDependencies,
): Promise<ServerHealth | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await dependencies.fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return null;
    }

    const parsedBody = ServerHealthResponseSchema.safeParse(await res.json?.());
    if (!parsedBody.success) return null;

    const health: ServerHealth = { healthy: parsedBody.data.healthy === true };
    const version = z.string().safeParse(parsedBody.data.version);
    if (version.success) {
      health.version = version.data;
    }
    return health;
  } catch {
    return null;
  }
}

/**
 * Read the installed OpenCode CLI version from PATH.
 */
export async function getInstalledOpencodeVersion(
  dependencies: ServerDependencies = defaultDependencies,
): Promise<string | null> {
  try {
    const { stdout } = await dependencies.execa("opencode", ["--version"], { timeout: 5000 });
    const trimmed = stdout?.trim() ?? "";
    if (!trimmed) {
      return null;
    }

    const match = trimmed.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
    return match?.[1] ?? trimmed;
  } catch {
    return null;
  }
}

/**
 * Check if an OpenCode server is running on the given port
 */
export async function isServerRunning(
  port: number,
  dependencies: ServerDependencies = defaultDependencies,
): Promise<boolean> {
  const health = await getServerHealth(port, dependencies);
  return health?.healthy === true;
}

/**
 * Ensure an OpenCode server is running. Connects to existing or spawns new.
 * Restarts a stale listener when its reported version differs from the CLI.
 * Returns the base URL.
 */
export async function ensureServer(
  port: number,
  dependencies: ServerDependencies = defaultDependencies,
): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await getServerHealth(port, dependencies);
  if (health?.healthy) {
    const cliVersion = await getInstalledOpencodeVersion(dependencies);
    if (health.version && cliVersion && health.version !== cliVersion) {
      if (!(await stopServer(port, dependencies))) {
        throw new Error(`Could not locate or stop stale OpenCode server on port ${port}.`);
      }
    } else {
      return baseUrl;
    }
  }

  const stoppedUnhealthyListener = await stopUnhealthyServerListener(port, dependencies);
  if (stoppedUnhealthyListener) {
    await waitUntilPortFree(port, dependencies);
  } else if (await isPortListening(port, dependencies)) {
    throw new Error(
      `Port ${port} is already in use by a non-OpenCode process. Stop that process or configure a different DiffOwl server port.`,
    );
  }

  await spawnServer(port, dependencies);

  for (let i = 0; i < MAX_RETRIES; i++) {
    await sleep(STARTUP_WAIT_MS / MAX_RETRIES);
    if (await isServerRunning(port, dependencies)) {
      return baseUrl;
    }
  }

  await sleep(STARTUP_WAIT_MS);
  if (await isServerRunning(port, dependencies)) {
    return baseUrl;
  }

  throw new Error(
    `Failed to start OpenCode server on port ${port}. Is opencode installed? (npm i -g opencode-ai)`,
  );
}

async function checkOpencodeInstalled(dependencies: ServerDependencies): Promise<void> {
  const isWin = process.platform === "win32";
  const checkCmd = isWin ? "where" : "which";
  try {
    await dependencies.execa(checkCmd, ["opencode"]);
  } catch {
    try {
      await dependencies.execa("opencode", ["--version"], { timeout: 5000 });
    } catch {
      throw new Error(
        "opencode not found. Install it: npm i -g opencode-ai\nSee: https://opencode.ai/docs/",
      );
    }
  }
}

/**
 * Spawn opencode serve as a detached background process
 */
async function spawnServer(port: number, dependencies: ServerDependencies): Promise<void> {
  const dir = await dependencies.ensureDiffOwlDir();
  const pidFile = join(dir, "server.pid");

  await checkOpencodeInstalled(dependencies);

  const subprocess = dependencies.execa("opencode", ["serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    cleanup: false,
  });

  // Detached startup failures are reported by ensureServer's health check.
  // Attach this immediately so a fast child exit cannot become an unhandled
  // rejection before hook-mode reviews can write failure status.
  void subprocess.catch(() => {});

  if (subprocess.pid) {
    await dependencies.writeFile(pidFile, String(subprocess.pid), "utf-8");
  }

  subprocess.unref?.();
}

/**
 * Stop the OpenCode server on the configured port.
 * Tries the managed PID file first, then any opencode serve listener on the port.
 */
export async function stopServer(
  port: number,
  dependencies: ServerDependencies = defaultDependencies,
): Promise<boolean> {
  if (await stopManagedServer(dependencies)) {
    await waitUntilPortFree(port, dependencies);
    return true;
  }

  const listenerPid = await findOpencodeListenerPid(port, dependencies);
  if (listenerPid === null) {
    return false;
  }

  if (!(await isOpencodeProcess(listenerPid, dependencies))) {
    return false;
  }

  try {
    dependencies.kill(listenerPid, "SIGTERM");
  } catch {
    return false;
  }

  await cleanupPidFile(dependencies);
  await waitUntilPortFree(port, dependencies);
  return true;
}

async function stopManagedServer(dependencies: ServerDependencies): Promise<boolean> {
  const dir = dependencies.getDiffOwlDir();
  const pidFile = join(dir, "server.pid");

  if (!dependencies.existsSync(pidFile)) {
    return false;
  }

  let pid: number;
  try {
    pid = parseInt(await dependencies.readFile(pidFile, "utf-8"), 10);
  } catch {
    try {
      await dependencies.unlink(pidFile);
    } catch {}
    return false;
  }

  try {
    dependencies.kill(pid, 0);
  } catch {
    try {
      await dependencies.unlink(pidFile);
    } catch {}
    return false;
  }

  if (!(await isOpencodeProcess(pid, dependencies))) {
    try {
      await dependencies.unlink(pidFile);
    } catch {}
    return false;
  }

  try {
    dependencies.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  try {
    await dependencies.unlink(pidFile);
  } catch {}

  return true;
}

async function stopUnhealthyServerListener(
  port: number,
  dependencies: ServerDependencies,
): Promise<boolean> {
  const listenerPid = await findOpencodeListenerPid(port, dependencies);
  if (listenerPid === null) {
    return false;
  }

  try {
    dependencies.kill(listenerPid, "SIGTERM");
  } catch (error) {
    if (isProcessMissingError(error)) {
      return false;
    }
    throw new Error(
      `Could not stop unhealthy OpenCode server on port ${port}: ${describeError(error)}`,
    );
  }

  await cleanupPidFile(dependencies);
  return true;
}

async function cleanupPidFile(dependencies: ServerDependencies): Promise<void> {
  const pidFile = join(dependencies.getDiffOwlDir(), "server.pid");
  if (!dependencies.existsSync(pidFile)) {
    return;
  }

  try {
    await dependencies.unlink(pidFile);
  } catch {}
}

async function findOpencodeListenerPid(
  port: number,
  dependencies: ServerDependencies,
): Promise<number | null> {
  const pids = await findListenerPids(port, dependencies);

  for (const pid of pids) {
    if (await isOpencodeProcess(pid, dependencies)) {
      return pid;
    }
  }
  return null;
}

async function isPortListening(port: number, dependencies: ServerDependencies): Promise<boolean> {
  return (await findListenerPids(port, dependencies)).length > 0;
}

async function findListenerPids(port: number, dependencies: ServerDependencies): Promise<number[]> {
  if (process.platform === "win32") {
    return findListenerPidsWindows(port, dependencies);
  }

  try {
    const { stdout } = await dependencies.execa(
      "lsof",
      ["-tiTCP:" + String(port), "-sTCP:LISTEN"],
      {
        timeout: 5000,
      },
    );
    return parsePids(stdout ?? "");
  } catch {
    return [];
  }
}

async function findListenerPidsWindows(
  port: number,
  dependencies: ServerDependencies,
): Promise<number[]> {
  try {
    const { stdout } = await dependencies.execa("netstat", ["-ano"], { timeout: 5000 });
    const portToken = `:${port}`;
    const lines = (stdout ?? "").split(/\r?\n/);
    const pids = new Set<number>();

    for (const line of lines) {
      if (!line.includes("LISTENING") || !line.includes(portToken)) {
        continue;
      }

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1] ?? "", 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }

      pids.add(pid);
    }
    return [...pids];
  } catch {}

  return [];
}

function parsePids(stdout: string): number[] {
  return stdout
    .trim()
    .split(/\s+/)
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function waitUntilPortFree(port: number, dependencies: ServerDependencies): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port, dependencies))) {
      return;
    }
    await sleep(PORT_RELEASE_POLL_MS);
  }

  if (await isPortListening(port, dependencies)) {
    throw new Error(
      `OpenCode server on port ${port} did not stop within ${PORT_RELEASE_WAIT_MS}ms. Retry: diffowl server stop && diffowl server start`,
    );
  }
}

async function isOpencodeProcess(pid: number, dependencies: ServerDependencies): Promise<boolean> {
  const isWin = process.platform === "win32";

  try {
    if (isWin) {
      try {
        const { stdout } = await dependencies.execa("powershell", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`,
        ]);
        if ((stdout ?? "").toLowerCase().includes("opencode")) {
          return true;
        }
      } catch {}

      try {
        const { stdout } = await dependencies.execa("wmic", [
          "process",
          "where",
          `ProcessId=${pid}`,
          "get",
          "CommandLine",
        ]);
        if ((stdout ?? "").toLowerCase().includes("opencode")) {
          return true;
        }
      } catch {}

      const { stdout } = await dependencies.execa("tasklist", [
        "/FI",
        `PID eq ${pid}`,
        "/FO",
        "CSV",
        "/NH",
      ]);
      return (stdout ?? "").toLowerCase().includes("opencode");
    }

    const { stdout } = await dependencies.execa("ps", ["-p", String(pid), "-o", "command="]);
    return (stdout ?? "").toLowerCase().includes("opencode");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: BoundaryValue): string {
  const parsedError = z.instanceof(Error).safeParse(error);
  if (parsedError.success) return parsedError.data.message;

  return String(error);
}

function isProcessMissingError(error: BoundaryValue): boolean {
  const parsedError = ProcessErrorSchema.safeParse(error);
  if (!parsedError.success) return false;

  return z.literal("ESRCH").safeParse(parsedError.data.code).success;
}
