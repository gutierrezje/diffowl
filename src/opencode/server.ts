import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureDiffOwlDir, getDiffOwlDir } from "../config.js";

const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_WAIT_MS = 3000;
const MAX_RETRIES = 10;
const PORT_RELEASE_WAIT_MS = 5000;
const PORT_RELEASE_POLL_MS = 200;

export type ServerHealth = {
  healthy: boolean;
  version?: string;
};

/**
 * Fetch OpenCode server health, including the running server version when reported.
 */
export async function getServerHealth(port: number): Promise<ServerHealth | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return null;
    }

    const body = (await res.json()) as { healthy?: boolean; version?: string };
    const health: ServerHealth = { healthy: body.healthy === true };
    if (typeof body.version === "string") {
      health.version = body.version;
    }
    return health;
  } catch {
    return null;
  }
}

/**
 * Read the installed OpenCode CLI version from PATH.
 */
export async function getInstalledOpencodeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execa("opencode", ["--version"], { timeout: 5000 });
    const trimmed = stdout.trim();
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
export async function isServerRunning(port: number): Promise<boolean> {
  const health = await getServerHealth(port);
  return health?.healthy === true;
}

/**
 * Ensure an OpenCode server is running. Connects to existing or spawns new.
 * Restarts a stale listener when its reported version differs from the CLI.
 * Returns the base URL.
 */
export async function ensureServer(port: number): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await getServerHealth(port);
  if (health?.healthy) {
    const cliVersion = await getInstalledOpencodeVersion();
    if (health.version && cliVersion && health.version !== cliVersion) {
      if (!(await stopServer(port))) {
        throw new Error(`Could not locate or stop stale OpenCode server on port ${port}.`);
      }
    } else {
      return baseUrl;
    }
  }

  const stoppedUnhealthyListener = await stopUnhealthyServerListener(port);
  if (stoppedUnhealthyListener) {
    await waitUntilPortFree(port);
  } else if (await isPortListening(port)) {
    throw new Error(
      `Port ${port} is already in use by a non-OpenCode process. Stop that process or configure a different DiffOwl server port.`,
    );
  }

  await spawnServer(port);

  for (let i = 0; i < MAX_RETRIES; i++) {
    await sleep(STARTUP_WAIT_MS / MAX_RETRIES);
    if (await isServerRunning(port)) {
      return baseUrl;
    }
  }

  await sleep(STARTUP_WAIT_MS);
  if (await isServerRunning(port)) {
    return baseUrl;
  }

  throw new Error(
    `Failed to start OpenCode server on port ${port}. Is opencode installed? (npm i -g opencode-ai)`,
  );
}

async function checkOpencodeInstalled(): Promise<void> {
  const isWin = process.platform === "win32";
  const checkCmd = isWin ? "where" : "which";
  try {
    await execa(checkCmd, ["opencode"]);
  } catch {
    try {
      await execa("opencode", ["--version"], { timeout: 5000 });
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
async function spawnServer(port: number): Promise<void> {
  const dir = await ensureDiffOwlDir();
  const pidFile = join(dir, "server.pid");

  await checkOpencodeInstalled();

  const subprocess = execa("opencode", ["serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    cleanup: false,
  });

  // Detached startup failures are reported by ensureServer's health check.
  // Attach this immediately so a fast child exit cannot become an unhandled
  // rejection before hook-mode reviews can write failure status.
  void subprocess.catch(() => {});

  if (subprocess.pid) {
    await writeFile(pidFile, String(subprocess.pid), "utf-8");
  }

  subprocess.unref();
}

/**
 * Stop the OpenCode server on the configured port.
 * Tries the managed PID file first, then any opencode serve listener on the port.
 */
export async function stopServer(port: number): Promise<boolean> {
  if (await stopManagedServer()) {
    await waitUntilPortFree(port);
    return true;
  }

  const listenerPid = await findOpencodeListenerPid(port);
  if (listenerPid === null) {
    return false;
  }

  if (!(await isOpencodeProcess(listenerPid))) {
    return false;
  }

  try {
    process.kill(listenerPid, "SIGTERM");
  } catch {
    return false;
  }

  await cleanupPidFile();
  await waitUntilPortFree(port);
  return true;
}

async function stopManagedServer(): Promise<boolean> {
  const dir = getDiffOwlDir();
  const pidFile = join(dir, "server.pid");

  if (!existsSync(pidFile)) {
    return false;
  }

  let pid: number;
  try {
    pid = parseInt(await readFile(pidFile, "utf-8"), 10);
  } catch {
    try {
      await unlink(pidFile);
    } catch {}
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch {
    try {
      await unlink(pidFile);
    } catch {}
    return false;
  }

  if (!(await isOpencodeProcess(pid))) {
    try {
      await unlink(pidFile);
    } catch {}
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  try {
    await unlink(pidFile);
  } catch {}

  return true;
}

async function stopUnhealthyServerListener(port: number): Promise<boolean> {
  const listenerPid = await findOpencodeListenerPid(port);
  if (listenerPid === null) {
    return false;
  }

  try {
    process.kill(listenerPid, "SIGTERM");
  } catch (error) {
    throw new Error(
      `Could not stop unhealthy OpenCode server on port ${port}: ${describeError(error)}`,
    );
  }

  await cleanupPidFile();
  return true;
}

async function cleanupPidFile(): Promise<void> {
  const pidFile = join(getDiffOwlDir(), "server.pid");
  if (!existsSync(pidFile)) {
    return;
  }

  try {
    await unlink(pidFile);
  } catch {}
}

async function findOpencodeListenerPid(port: number): Promise<number | null> {
  const pids = await findListenerPids(port);

  for (const pid of pids) {
    if (await isOpencodeProcess(pid)) {
      return pid;
    }
  }
  return null;
}

async function isPortListening(port: number): Promise<boolean> {
  return (await findListenerPids(port)).length > 0;
}

async function findListenerPids(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    return findListenerPidsWindows(port);
  }

  try {
    const { stdout } = await execa("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], {
      timeout: 5000,
    });
    return parsePids(stdout);
  } catch {
    return [];
  }
}

async function findListenerPidsWindows(port: number): Promise<number[]> {
  try {
    const { stdout } = await execa("netstat", ["-ano"], { timeout: 5000 });
    const portToken = `:${port}`;
    const lines = stdout.split(/\r?\n/);
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

async function waitUntilPortFree(port: number): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) {
      return;
    }
    await sleep(PORT_RELEASE_POLL_MS);
  }

  if (await isPortListening(port)) {
    throw new Error(
      `OpenCode server on port ${port} did not stop within ${PORT_RELEASE_WAIT_MS}ms. Retry: diffowl server stop && diffowl server start`,
    );
  }
}

async function isOpencodeProcess(pid: number): Promise<boolean> {
  const isWin = process.platform === "win32";

  try {
    if (isWin) {
      try {
        const { stdout } = await execa("powershell", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`,
        ]);
        if (stdout.toLowerCase().includes("opencode")) {
          return true;
        }
      } catch {}

      try {
        const { stdout } = await execa("wmic", [
          "process",
          "where",
          `ProcessId=${pid}`,
          "get",
          "CommandLine",
        ]);
        if (stdout.toLowerCase().includes("opencode")) {
          return true;
        }
      } catch {}

      const { stdout } = await execa("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return stdout.toLowerCase().includes("opencode");
    }

    const { stdout } = await execa("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.toLowerCase().includes("opencode");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
