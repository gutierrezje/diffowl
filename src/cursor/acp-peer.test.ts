import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpPeerError, startAcpPeer } from "./acp-peer.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-cursor-agent.mjs", import.meta.url));

describe("startAcpPeer", () => {
  it.each([
    ["malformed-json", "malformed-json"],
    ["malformed-envelope", "malformed-envelope"],
    ["unknown-response-id", "malformed-envelope"],
    ["premature-eof", "premature-eof"],
  ] as const)("rejects %s protocol failure", async (mode, expectedKind) => {
    const peer = createPeer(mode);
    try {
      await expect(peer.request("initialize", {})).rejects.toMatchObject({
        name: "AcpPeerError",
        kind: expectedKind,
      });
    } finally {
      await peer.close();
    }
  });

  it("reports SIGKILL when stdin and SIGTERM cannot stop the child", async () => {
    const peer = createPeer("sigkill");

    await expect(peer.close()).resolves.toMatchObject({
      kind: "sigkill",
      signal: "SIGKILL",
    });
  });

  it("rejects requests after the peer is closed", async () => {
    const peer = createPeer("success");
    await peer.close();

    await expect(peer.request("initialize", {})).rejects.toBeInstanceOf(AcpPeerError);
  });

  it("rejects pending requests when the child closes", async () => {
    const peer = createPeer("hang-initialize");
    const pending = peer.request("initialize", {});

    await peer.close();

    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("pending request was not rejected")), 100),
        ),
      ]),
    ).rejects.toMatchObject({ name: "AcpPeerError", kind: "process" });
  });
});

function createPeer(mode: string) {
  return startAcpPeer({
    executable: process.execPath,
    args: [fixture, "acp"],
    cwd: process.cwd(),
    env: { MOCK_CURSOR_MODE: mode },
    closeTimeoutMs: 300,
  });
}
