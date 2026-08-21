import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { AppServerPeerError, startAppServerPeer } from "./app-server-peer.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));

describe("startAppServerPeer", () => {
  it("throws a typed missing executable error synchronously", () => {
    const executable = join(tmpdir(), `diffowl-missing-app-server-${randomUUID()}`);
    let thrown: unknown;
    try {
      startAppServerPeer({ executable });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppServerPeerError);
    expect(thrown).toMatchObject({ kind: "executable-missing" });
  });

  it("resolves a bare executable through the supplied PATH and PATHEXT", async () => {
    const executable =
      process.platform === "win32"
        ? basename(process.execPath, extname(process.execPath))
        : basename(process.execPath);
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const peer = startAppServerPeer({
      executable,
      args: [fixture],
      env: {
        [pathKey]: dirname(process.execPath),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        MOCK_APP_SERVER_MODE: "immediate",
      },
      closeTimeoutMs: 500,
    });

    await expect(peer.request("bare")).resolves.toEqual({ request: "bare" });
    await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
  });

  it.skipIf(process.platform === "win32")(
    "skips a non-executable PATH candidate and uses the next executable",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "diffowl-app-server-path-"));
      const first = join(root, "first");
      const second = join(root, "second");
      const executable = "codex-test";
      try {
        await Promise.all([mkdir(first), mkdir(second)]);
        await writeFile(join(first, executable), "not executable");
        await chmod(join(first, executable), 0o644);
        await symlink(process.execPath, join(second, executable));
        const peer = startAppServerPeer({
          executable,
          args: [fixture],
          env: {
            PATH: `${first}:${second}`,
            MOCK_APP_SERVER_MODE: "immediate",
          },
          closeTimeoutMs: 500,
        });

        await expect(peer.request("path-fallback")).resolves.toEqual({
          request: "path-fallback",
        });
        await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("resolves a relative executable from the child cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diffowl-relative-app-server-"));
    try {
      const peer = startAppServerPeer({
        executable: relative(cwd, process.execPath),
        cwd,
        args: [fixture],
        env: { MOCK_APP_SERVER_MODE: "immediate" },
        closeTimeoutMs: 500,
      });

      await expect(peer.request("relative")).resolves.toEqual({ request: "relative" });
      await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects and closes when the child cwd does not exist", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      cwd: join(tmpdir(), `diffowl-missing-cwd-${randomUUID()}`),
      closeTimeoutMs: 100,
    });

    await expect(peer.request("missing-cwd")).rejects.toMatchObject({ kind: "process" });
    await expect(peer.close()).resolves.toBeDefined();
  });

  it("registers a request before an immediate child reply can arrive", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "immediate" },
      closeTimeoutMs: 500,
    });

    await expect(peer.request("immediate")).resolves.toEqual({ request: "immediate" });
    await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
  });

  it("rejects RPC errors without affecting another pending request", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "rpc-error" },
      closeTimeoutMs: 500,
    });

    const failed = peer.request("bad", { value: 1 });
    const good = peer.request("good", { value: 2 });
    await expect(failed).rejects.toMatchObject({
      kind: "rpc-error",
      id: 1,
      rpcError: { code: 42, message: "bad request", data: { field: "x" } },
    });
    await expect(good).resolves.toEqual({ request: "good" });
    await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
  });

  it("removes an aborted request before teardown", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "basic" },
      closeTimeoutMs: 500,
    });
    const controller = new AbortController();
    const reason = new Error("request deadline expired");

    const pending = peer.request("never-completes", undefined, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await expect(peer.request("follow-up")).resolves.toEqual({ request: "second" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
  });

  it.each([
    ["malformed-json", "malformed-json"],
    ["malformed-envelope", "malformed-envelope"],
  ] as const)("rejects %s with a stable kind and closes boundedly", async (mode, kind) => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: mode },
      closeTimeoutMs: 100,
    });

    await expect(peer.request("invalid")).rejects.toMatchObject({ kind });
    await expect(peer.close()).resolves.toMatchObject({ kind: "sigterm" });
  });

  it("rejects every pending request when the child ends before close", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "premature-eof" },
      closeTimeoutMs: 100,
    });

    const first = peer.request("first");
    const second = peer.request("second");
    await expect(first).rejects.toMatchObject({ kind: "premature-eof" });
    await expect(second).rejects.toMatchObject({ kind: "premature-eof" });
    const close = await peer.close();
    expect(close.code).toBe(0);
    expect(["exit", "sigterm"]).toContain(close.kind);
  });

  it.skipIf(process.platform === "win32")(
    "rejects pending requests when stdout ends before the child exits",
    async () => {
      const peer = startAppServerPeer({
        executable: process.execPath,
        args: [fixture],
        env: { MOCK_APP_SERVER_MODE: "stdout-eof-hung" },
        closeTimeoutMs: 100,
      });
      const pid = peer.pid;
      if (pid === undefined) throw new Error("peer did not expose a pid");

      try {
        await expect(peer.request("close-stdout")).rejects.toMatchObject({
          kind: "premature-eof",
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await peer.close().catch(() => undefined);
      }
    },
  );

  it("rejects an unexpected server request with a stable kind", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "server-request" },
      closeTimeoutMs: 100,
    });

    await expect(peer.request("request")).rejects.toMatchObject({
      kind: "unexpected-server-request",
      id: "server-request-1",
      method: "server.ask",
    });
    await expect(peer.close()).resolves.toMatchObject({ kind: "sigterm" });
  });

  it("shares an idempotent close and escalates a hung child to SIGTERM", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "hung" },
      closeTimeoutMs: 50,
    });
    const pid = peer.pid;
    if (pid === undefined) throw new Error("peer did not expose a pid");

    const closing = peer.close();
    expect(peer.close()).toBe(closing);
    await expect(closing).resolves.toMatchObject({ kind: "sigterm", signal: "SIGTERM" });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "waits for process exit after escalating teardown to SIGKILL",
    async () => {
      const peer = startAppServerPeer({
        executable: process.execPath,
        args: [fixture],
        env: { MOCK_APP_SERVER_MODE: "ignores-sigterm" },
        closeTimeoutMs: 3,
      });

      await expect(peer.request("ready")).resolves.toEqual({ request: "ready" });
      await expect(peer.close()).resolves.toMatchObject({ kind: "sigkill", signal: "SIGKILL" });
    },
  );

  it("correlates responses, delivers notifications, bounds stderr, and closes on stdin EOF", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "basic", MOCK_APP_SERVER_SECRET: "do-not-expose" },
      stderrMaxBytes: 32,
      closeTimeoutMs: 500,
    });

    expect(peer.pid).toBeTypeOf("number");
    const first = peer.request("first", { value: 1 });
    const second = peer.request("second", { value: 2 });

    await expect(first).resolves.toEqual({ request: "first" });
    await expect(second).resolves.toEqual({ request: "second" });
    await expect(peer.nextNotification()).resolves.toEqual({
      kind: "notification",
      method: "server.ready",
      params: { requests: 2 },
    });
    expect(peer.getStderr()).toHaveLength(32);

    const closing = peer.close();
    expect(peer.close()).toBe(closing);
    await expect(closing).resolves.toMatchObject({ kind: "eof", code: 0 });
  });

  it("redacts configured secrets from captured stderr", async () => {
    const peer = startAppServerPeer({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_APP_SERVER_MODE: "immediate", MOCK_APP_SERVER_SECRET: "do-not-expose" },
      stderrRedactions: ["do-not-expose"],
      closeTimeoutMs: 500,
    });

    await expect(peer.request("ready")).resolves.toEqual({ request: "ready" });
    expect(peer.getStderr()).toContain("[REDACTED]");
    expect(peer.getStderr()).not.toContain("do-not-expose");
    await expect(peer.close()).resolves.toMatchObject({ kind: "eof", code: 0 });
  });
});
