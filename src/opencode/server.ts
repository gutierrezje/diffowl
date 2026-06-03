import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureDiffOwlDir, getDiffOwlDir } from "../config.js";

const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_WAIT_MS = 3000;
const MAX_RETRIES = 10;

/**
 * Check if an OpenCode server is running on the given port
 */
export async function isServerRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure an OpenCode server is running. Connects to existing or spawns new.
 * Returns the base URL.
 */
export async function ensureServer(port: number): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}`;

  // Check if already running
  if (await isServerRunning(port)) {
    return baseUrl;
  }

  // Spawn a new server
  await spawnServer(port);

  // Wait for it to be ready
  for (let i = 0; i < MAX_RETRIES; i++) {
    await sleep(STARTUP_WAIT_MS / MAX_RETRIES);
    if (await isServerRunning(port)) {
      return baseUrl;
    }
  }

  // Try a bit longer
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

  // Write PID for later cleanup
  if (subprocess.pid) {
    await writeFile(pidFile, String(subprocess.pid), "utf-8");
  }

  // Unref so our process can exit
  subprocess.unref();
}

/**
 * Stop a previously spawned server
 */
export async function stopServer(): Promise<boolean> {
  const dir = getDiffOwlDir();
  const pidFile = join(dir, "server.pid");

  if (!existsSync(pidFile)) return false;

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
    // Check if the process is alive
    process.kill(pid, 0);
  } catch {
    // Process is dead (ESRCH), clean up stale pid file
    try {
      await unlink(pidFile);
    } catch {}
    return false;
  }

  // Double-check if the process is actually OpenCode
  if (!(await isOpencodeProcess(pid))) {
    // Recycled PID belongs to an unrelated process. Clean up but do not kill.
    try {
      await unlink(pidFile);
    } catch {}
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    await unlink(pidFile);
    return true;
  } catch {
    return false;
  }
}

async function isOpencodeProcess(pid: number): Promise<boolean> {
  const isWin = process.platform === "win32";

  try {
    if (isWin) {
      // Try using PowerShell to get full CommandLine (most robust)
      try {
        const { stdout } = await execa("powershell", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`,
        ]);
        if (stdout.toLowerCase().includes("opencode")) {
          return true;
        }
      } catch {
        // Fall back to wmic if PowerShell query fails
      }

      // Try using wmic to get full CommandLine (intentionally legacy second-level fallback)
      // Note: wmic is deprecated since Windows 10 1809 and removed in Windows 11 24H2.
      // This is kept strictly as a legacy compatibility check for older environments.
      // If missing on modern Windows, it will throw immediately and fall through to tasklist.
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
      } catch {
        // Fall back to tasklist if wmic fails or is missing
      }

      // Fallback: use tasklist to check image name (strictly look for opencode)
      const { stdout } = await execa("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return stdout.toLowerCase().includes("opencode");
    } else {
      // POSIX: Keep ps -p ... (works on Linux/macOS)
      const { stdout } = await execa("ps", ["-p", String(pid), "-o", "command="]);
      return stdout.toLowerCase().includes("opencode");
    }
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
