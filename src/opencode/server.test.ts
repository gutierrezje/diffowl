import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  fetch: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  existsSync: vi.fn(),
  ensureDiffOwlDir: vi.fn(),
  getDiffOwlDir: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: mocks.writeFile,
    readFile: mocks.readFile,
    unlink: mocks.unlink,
  };
});

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    ensureDiffOwlDir: mocks.ensureDiffOwlDir,
    getDiffOwlDir: mocks.getDiffOwlDir,
  };
});

describe("getServerHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "fetch");
  });

  it("returns health and version from the server endpoint", async () => {
    const { getServerHealth } = await import("./server.js");
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true, version: "1.17.7" }),
    });
    vi.stubGlobal("fetch", mocks.fetch);

    await expect(getServerHealth(4096)).resolves.toEqual({
      healthy: true,
      version: "1.17.7",
    });
  });
});

describe("ensureServer", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.execa.mockReset();
    mocks.fetch.mockReset();
    mocks.writeFile.mockReset();
    mocks.readFile.mockReset();
    mocks.unlink.mockReset();
    mocks.existsSync.mockReset();
    mocks.ensureDiffOwlDir.mockReset();
    mocks.getDiffOwlDir.mockReset();
    mocks.kill.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "fetch");
    mocks.kill.mockReset();
  });

  it("handles fast detached server exits through the health-check failure path", async () => {
    vi.useFakeTimers();
    const { ensureServer } = await import("./server.js");
    const rejection = Promise.reject(new Error("serve failed"));
    rejection.catch(() => {});
    const child = Object.assign(rejection, {
      pid: 12345,
      unref: vi.fn(),
    });

    mocks.ensureDiffOwlDir.mockResolvedValue("/tmp/diffowl");
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.existsSync.mockReturnValue(false);
    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      if (command === "which") {
        return Promise.resolve({ stdout: "/usr/local/bin/opencode" });
      }
      if (command === "opencode" && args?.[0] === "serve") {
        return child;
      }
      return Promise.resolve({ stdout: "" });
    });
    mocks.fetch.mockRejectedValue(new Error("not running"));
    vi.stubGlobal("fetch", mocks.fetch);

    const result = expect(ensureServer(4096)).rejects.toThrow(
      "Failed to start OpenCode server on port 4096",
    );
    await vi.runAllTimersAsync();

    await result;
    expect(child.unref).toHaveBeenCalled();
  });

  it("reuses a healthy server when versions match", async () => {
    const { ensureServer } = await import("./server.js");
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true, version: "1.17.7" }),
    });
    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      if (command === "opencode" && args?.[0] === "--version") {
        return Promise.resolve({ stdout: "1.17.7\n" });
      }
      return Promise.resolve({ stdout: "" });
    });
    vi.stubGlobal("fetch", mocks.fetch);

    await expect(ensureServer(4096)).resolves.toBe("http://127.0.0.1:4096");
    expect(mocks.execa).toHaveBeenCalledWith("opencode", ["--version"], { timeout: 5000 });
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.anything(),
    );
  });

  it("restarts a stale server when health and CLI versions differ", async () => {
    vi.useFakeTimers();
    const { ensureServer } = await import("./server.js");
    const child = Promise.resolve() as Promise<unknown> & {
      pid: number;
      unref: () => void;
      catch: (handler: (err: unknown) => void) => void;
    };
    child.pid = 22222;
    child.unref = vi.fn();
    child.catch = vi.fn();

    mocks.ensureDiffOwlDir.mockResolvedValue("/tmp/diffowl");
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.existsSync.mockReturnValue(false);

    let healthChecks = 0;
    mocks.fetch.mockImplementation(async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        return {
          ok: true,
          json: async () => ({ healthy: true, version: "1.15.13" }),
        };
      }
      if (healthChecks <= 3) {
        return { ok: false };
      }
      return {
        ok: true,
        json: async () => ({ healthy: true, version: "1.17.7" }),
      };
    });
    vi.stubGlobal("fetch", mocks.fetch);

    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      if (command === "opencode" && args?.[0] === "--version") {
        return Promise.resolve({ stdout: "1.17.7\n" });
      }
      if (command === "lsof") {
        return Promise.resolve({ stdout: "11111\n" });
      }
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      if (command === "which") {
        return Promise.resolve({ stdout: "/usr/local/bin/opencode" });
      }
      if (command === "opencode" && args?.[0] === "serve") {
        return child;
      }
      return Promise.resolve({ stdout: "" });
    });

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      mocks.kill(pid, signal);
      return originalKill(pid, 0);
    });

    const result = ensureServer(4096);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("http://127.0.0.1:4096");

    expect(mocks.kill).toHaveBeenCalledWith(11111, "SIGTERM");
    expect(mocks.execa).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("fails when a stale server does not release its port in time", async () => {
    vi.useFakeTimers();
    const { ensureServer } = await import("./server.js");

    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.existsSync.mockReturnValue(false);
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true, version: "1.15.13" }),
    });
    vi.stubGlobal("fetch", mocks.fetch);

    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      if (command === "opencode" && args?.[0] === "--version") {
        return Promise.resolve({ stdout: "1.17.7\n" });
      }
      if (command === "lsof") {
        return Promise.resolve({ stdout: "11111\n" });
      }
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      mocks.kill(pid, signal);
      return originalKill(pid, 0);
    });

    const result = expect(ensureServer(4096)).rejects.toThrow(
      "OpenCode server on port 4096 did not stop within",
    );
    await vi.runAllTimersAsync();
    await result;
  });
});

describe("stopServer", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.execa.mockReset();
    mocks.existsSync.mockReset();
    mocks.getDiffOwlDir.mockReset();
    mocks.kill.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the port listener when no managed pid file exists", async () => {
    const { stopServer } = await import("./server.js");
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.existsSync.mockReturnValue(false);
    mocks.execa.mockImplementation((command: string) => {
      if (command === "lsof") {
        return Promise.resolve({ stdout: "33333\n" });
      }
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      mocks.kill(pid, signal);
      if (signal === 0) {
        return originalKill(pid, 0);
      }
      return true;
    });

    await expect(stopServer(4096)).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(33333, "SIGTERM");
  });
});
