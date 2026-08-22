import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureServer, getServerHealth, stopServer, type ServerDependencies } from "./server.js";

const mocks = {
  execa: vi.fn<ServerDependencies["execa"]>(),
  fetch: vi.fn<ServerDependencies["fetch"]>(),
  writeFile: vi.fn<ServerDependencies["writeFile"]>(),
  readFile: vi.fn<ServerDependencies["readFile"]>(),
  unlink: vi.fn<ServerDependencies["unlink"]>(),
  existsSync: vi.fn<ServerDependencies["existsSync"]>(),
  ensureDiffOwlDir: vi.fn<ServerDependencies["ensureDiffOwlDir"]>(),
  getDiffOwlDir: vi.fn<ServerDependencies["getDiffOwlDir"]>(),
  kill: vi.fn<ServerDependencies["kill"]>(),
};

const dependencies: ServerDependencies = {
  execa: mocks.execa,
  fetch: mocks.fetch,
  writeFile: mocks.writeFile,
  readFile: mocks.readFile,
  unlink: mocks.unlink,
  existsSync: mocks.existsSync,
  ensureDiffOwlDir: mocks.ensureDiffOwlDir,
  getDiffOwlDir: mocks.getDiffOwlDir,
  kill: mocks.kill,
};

/**
 * Build a netstat -ano line that `findOpencodeListenerPidWindows` will parse.
 */
function netstatLine(port: number, pid: number): string {
  return `  TCP    0.0.0.0:${port}           0.0.0.0:0              LISTENING       ${pid}\r\n`;
}

/**
 * Minimal stand-in for the detached execa child spawnServer creates: a real
 * promise (so its `.catch` wiring is exercised, not mocked away) carrying the
 * `pid` and `unref` members the production code touches.
 */
function fakeServeChild(
  pid: number,
  outcome: Promise<{ stdout: string | undefined }> = Promise.resolve({ stdout: undefined }),
) {
  return Object.assign(outcome, { pid, unref: vi.fn() });
}

describe("getServerHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "fetch");
  });

  it("returns health and version from the server endpoint", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true, version: "1.17.7" }),
    });
    vi.stubGlobal("fetch", mocks.fetch);

    await expect(getServerHealth(4096, dependencies)).resolves.toEqual({
      healthy: true,
      version: "1.17.7",
    });
  });
});

describe("ensureServer", () => {
  beforeEach(() => {
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
    const rejection = Promise.reject(new Error("serve failed"));
    rejection.catch(() => {});
    const child = fakeServeChild(12345, rejection);

    mocks.ensureDiffOwlDir.mockResolvedValue("/tmp/diffowl");
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.existsSync.mockReturnValue(false);
    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      // checkOpencodeInstalled: Unix `which`, Windows `where`
      if (command === "which" || command === "where") {
        return Promise.resolve({ stdout: "/usr/local/bin/opencode" });
      }
      if (command === "opencode" && args?.[0] === "serve") {
        return child;
      }
      return Promise.resolve({ stdout: "" });
    });
    mocks.fetch.mockRejectedValue(new Error("not running"));
    vi.stubGlobal("fetch", mocks.fetch);

    const result = expect(ensureServer(4096, dependencies)).rejects.toThrow(
      "Failed to start OpenCode server on port 4096",
    );
    await vi.runAllTimersAsync();

    await result;
    expect(child.unref).toHaveBeenCalled();
  });

  it("clears an unhealthy opencode listener before spawning a replacement", async () => {
    vi.useFakeTimers();
    const child = fakeServeChild(22222);

    mocks.ensureDiffOwlDir.mockResolvedValue("/tmp/diffowl");
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.existsSync.mockReturnValue(true);
    mocks.unlink.mockResolvedValue(undefined);

    let healthChecks = 0;
    mocks.fetch.mockImplementation(async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        throw new Error("connection reset");
      }
      return {
        ok: true,
        json: async () => ({ healthy: true, version: "1.17.7" }),
      };
    });
    vi.stubGlobal("fetch", mocks.fetch);

    let lsofCalls = 0;
    let netstatCalls = 0;
    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      if (command === "lsof") {
        lsofCalls += 1;
        return Promise.resolve({ stdout: lsofCalls === 1 ? "11111\n" : "" });
      }
      if (command === "netstat") {
        netstatCalls += 1;
        return Promise.resolve({ stdout: netstatCalls === 1 ? netstatLine(4096, 11111) : "" });
      }
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      if (command === "which" || command === "where") {
        return Promise.resolve({ stdout: "/usr/local/bin/opencode" });
      }
      if (command === "opencode" && args?.[0] === "serve") {
        return child;
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockReturnValue(true);

    const result = ensureServer(4096, dependencies);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("http://127.0.0.1:4096");

    expect(mocks.kill).toHaveBeenCalledWith(11111, "SIGTERM");
    expect(mocks.unlink).toHaveBeenCalled();
    expect(mocks.execa).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("fails clearly when a non-opencode process occupies the port", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", mocks.fetch);

    mocks.execa.mockImplementation((command: string) => {
      // findListenerPids: Unix lsof, Windows netstat
      if (command === "lsof") {
        return Promise.resolve({ stdout: "55555\n" });
      }
      if (command === "netstat") {
        return Promise.resolve({ stdout: netstatLine(4096, 55555) });
      }
      // isOpencodeProcess: Unix ps, Windows powershell/wmic/tasklist
      if (command === "ps") {
        return Promise.resolve({ stdout: "python -m http.server 4096" });
      }
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "python -m http.server 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    await expect(ensureServer(4096, dependencies)).rejects.toThrow(
      "Port 4096 is already in use by a non-OpenCode process.",
    );
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.anything(),
    );
  });

  it("fails clearly when an unhealthy opencode listener cannot be stopped", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", mocks.fetch);

    mocks.execa.mockImplementation((command: string) => {
      // findListenerPids: Unix lsof, Windows netstat
      if (command === "lsof") {
        return Promise.resolve({ stdout: "11111\n" });
      }
      if (command === "netstat") {
        return Promise.resolve({ stdout: netstatLine(4096, 11111) });
      }
      // isOpencodeProcess: Unix ps, Windows powershell/wmic/tasklist
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockImplementation(() => {
      throw new Error("operation not permitted");
    });

    await expect(ensureServer(4096, dependencies)).rejects.toThrow(
      "Could not stop unhealthy OpenCode server on port 4096: operation not permitted",
    );
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.anything(),
    );
  });

  it("spawns when an unhealthy listener exits before signal delivery", async () => {
    vi.useFakeTimers();
    const child = fakeServeChild(22222);

    mocks.ensureDiffOwlDir.mockResolvedValue("/tmp/diffowl");
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.existsSync.mockReturnValue(false);

    let healthChecks = 0;
    mocks.fetch.mockImplementation(async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        throw new Error("connection reset");
      }
      return {
        ok: true,
        json: async () => ({ healthy: true, version: "1.17.7" }),
      };
    });
    vi.stubGlobal("fetch", mocks.fetch);

    let lsofCalls = 0;
    let netstatCalls = 0;
    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      // findListenerPids: Unix lsof, Windows netstat — listener gone on recheck
      if (command === "lsof") {
        lsofCalls += 1;
        return Promise.resolve({ stdout: lsofCalls === 1 ? "11111\n" : "" });
      }
      if (command === "netstat") {
        netstatCalls += 1;
        return Promise.resolve({ stdout: netstatCalls === 1 ? netstatLine(4096, 11111) : "" });
      }
      // isOpencodeProcess: Unix ps, Windows powershell/wmic/tasklist
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      if (command === "which" || command === "where") {
        return Promise.resolve({ stdout: "/usr/local/bin/opencode" });
      }
      if (command === "opencode" && args?.[0] === "serve") {
        return child;
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    const result = ensureServer(4096, dependencies);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("http://127.0.0.1:4096");
    expect(mocks.execa).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("reuses a healthy server when versions match", async () => {
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

    await expect(ensureServer(4096, dependencies)).resolves.toBe("http://127.0.0.1:4096");
    expect(mocks.execa).toHaveBeenCalledWith("opencode", ["--version"], { timeout: 5000 });
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096"],
      expect.anything(),
    );
  });

  it("restarts a stale server when health and CLI versions differ", async () => {
    vi.useFakeTimers();
    const child = fakeServeChild(22222);

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

    let lsofCalls = 0;
    let netstatCalls = 0;
    mocks.execa.mockImplementation((command: string, args?: string[]) => {
      if (command === "opencode" && args?.[0] === "--version") {
        return Promise.resolve({ stdout: "1.17.7\n" });
      }
      // findOpencodeListenerPid: Unix
      if (command === "lsof") {
        lsofCalls += 1;
        return Promise.resolve({ stdout: lsofCalls === 1 ? "11111\n" : "" });
      }
      // findOpencodeListenerPidWindows
      if (command === "netstat") {
        netstatCalls += 1;
        return Promise.resolve({ stdout: netstatCalls === 1 ? netstatLine(4096, 11111) : "" });
      }
      // isOpencodeProcess: Unix
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      // isOpencodeProcess: Windows (powershell tried first, then wmic, then tasklist)
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      // checkOpencodeInstalled: Unix `which`, Windows `where`
      if (command === "which" || command === "where") {
        return Promise.resolve({ stdout: "/usr/local/bin/opencode" });
      }
      if (command === "opencode" && args?.[0] === "serve") {
        return child;
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockReturnValue(true);

    const result = ensureServer(4096, dependencies);
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
      // findOpencodeListenerPid: Unix
      if (command === "lsof") {
        return Promise.resolve({ stdout: "11111\n" });
      }
      // findOpencodeListenerPidWindows
      if (command === "netstat") {
        return Promise.resolve({ stdout: netstatLine(4096, 11111) });
      }
      // isOpencodeProcess: Unix
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      // isOpencodeProcess: Windows
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockReturnValue(true);

    const result = expect(ensureServer(4096, dependencies)).rejects.toThrow(
      "OpenCode server on port 4096 did not stop within",
    );
    await vi.runAllTimersAsync();
    await result;
  });

  it("fails clearly when a stale server cannot be stopped", async () => {
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
      if (command === "lsof" || command === "netstat") {
        return Promise.resolve({ stdout: "" });
      }
      return Promise.resolve({ stdout: "" });
    });

    await expect(ensureServer(4096, dependencies)).rejects.toThrow(
      "Could not locate or stop stale OpenCode server on port 4096.",
    );
  });
});

describe("stopServer", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
    mocks.existsSync.mockReset();
    mocks.readFile.mockReset();
    mocks.unlink.mockReset();
    mocks.getDiffOwlDir.mockReset();
    mocks.kill.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the port listener when no managed pid file exists", async () => {
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.existsSync.mockReturnValue(false);
    mocks.fetch.mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mocks.fetch);
    let lsofCalls = 0;
    let netstatCalls = 0;
    mocks.execa.mockImplementation((command: string) => {
      // findOpencodeListenerPid: Unix
      if (command === "lsof") {
        lsofCalls += 1;
        return Promise.resolve({ stdout: lsofCalls === 1 ? "33333\n" : "" });
      }
      // findOpencodeListenerPidWindows
      if (command === "netstat") {
        netstatCalls += 1;
        return Promise.resolve({ stdout: netstatCalls === 1 ? netstatLine(4096, 33333) : "" });
      }
      // isOpencodeProcess: Unix
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      // isOpencodeProcess: Windows
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockReturnValue(true);

    await expect(stopServer(4096, dependencies)).resolves.toBe(true);
    expect(mocks.kill).toHaveBeenCalledWith(33333, "SIGTERM");
  });

  it("returns true when managed server kill succeeds but pid file cleanup fails", async () => {
    mocks.getDiffOwlDir.mockReturnValue("/tmp/diffowl");
    mocks.existsSync.mockReturnValue(true);
    mocks.readFile.mockResolvedValue("44444");
    mocks.unlink.mockRejectedValue(new Error("permission denied"));
    mocks.fetch.mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.execa.mockImplementation((command: string) => {
      // isOpencodeProcess: Unix
      if (command === "ps") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      // isOpencodeProcess: Windows
      if (command === "powershell" || command === "wmic" || command === "tasklist") {
        return Promise.resolve({ stdout: "opencode serve --port 4096" });
      }
      return Promise.resolve({ stdout: "" });
    });

    mocks.kill.mockReturnValue(true);

    await expect(stopServer(4096, dependencies)).resolves.toBe(true);
    expect(mocks.unlink).toHaveBeenCalled();
  });
});
