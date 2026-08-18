import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { startAppServerPeer } from "./app-server-peer.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));

describe("startAppServerPeer", () => {
  it("classifies a missing executable before stdout EOF", async () => {
    const peer = startAppServerPeer({
      executable: join(tmpdir(), `diffowl-missing-app-server-${randomUUID()}`),
      closeTimeoutMs: 500,
    });

    await expect(peer.request("missing")).rejects.toMatchObject({ kind: "executable-missing" });
    await peer.close();
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
    await expect(peer.close()).resolves.toMatchObject({ kind: "exit", code: 0 });
  });

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
});
