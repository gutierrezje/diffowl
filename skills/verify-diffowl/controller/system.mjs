import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommand(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout,
    });
    return { exitCode: 0, stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return {
        exitCode: Number.isSafeInteger(error.code) ? error.code : 1,
        stdout: String(error.stdout ?? "").trimEnd(),
        stderr: String(error.stderr ?? error).trimEnd(),
      };
    }
    throw error;
  }
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfPresent(path) {
  if (!(await pathExists(path))) {
    return null;
  }
  return readFile(path, "utf8");
}

export async function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { pid, alive: false, command: null };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { pid, alive: false, command: null };
  }
  const result = await runCommand("ps", ["-p", String(pid), "-o", "command="]);
  return { pid, alive: result.exitCode === 0, command: result.stdout || null };
}

export async function inspectPort(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    return { port, listening: false };
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening) => {
      socket.destroy();
      resolve({ port, listening });
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
