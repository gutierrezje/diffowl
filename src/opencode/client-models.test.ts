import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isServerRunning: vi.fn(),
  ensureServer: vi.fn(),
  providerList: vi.fn(),
}));

vi.mock("./server.js", () => ({
  isServerRunning: mocks.isServerRunning,
  ensureServer: mocks.ensureServer,
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({
    provider: {
      list: mocks.providerList,
    },
  })),
}));

describe("getAvailableModels", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports a stopped server when autoStart is disabled", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(false);

    await expect(getAvailableModels(4096, { autoStart: false })).rejects.toThrow(
      "OpenCode server is not running",
    );

    expect(mocks.ensureServer).not.toHaveBeenCalled();
    expect(mocks.providerList).not.toHaveBeenCalled();
  });

  it("propagates server startup failures", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(false);
    mocks.ensureServer.mockRejectedValue(new Error("failed to start OpenCode server"));

    await expect(getAvailableModels(4096)).rejects.toThrow("failed to start OpenCode server");
  });

  it("propagates provider list failures", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(true);
    mocks.providerList.mockRejectedValue(new Error("connection refused"));

    await expect(getAvailableModels(4096)).rejects.toThrow("connection refused");
  });

  it("returns an empty list when discovery succeeds without connected models", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(true);
    mocks.providerList.mockResolvedValue({ data: { connected: [], all: [] } });

    await expect(getAvailableModels(4096)).resolves.toEqual([]);
  });

  it("starts OpenCode by default before listing models", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(false);
    mocks.ensureServer.mockResolvedValue("http://127.0.0.1:4096");
    mocks.providerList.mockResolvedValue({
      data: {
        connected: ["provider"],
        all: [
          {
            id: "provider",
            models: {
              active: { id: "active", status: "active" },
              missingStatus: { id: "missing-status" },
              inactive: { id: "inactive", status: "disabled" },
            },
          },
        ],
      },
    });

    await expect(getAvailableModels(4096)).resolves.toEqual([
      "provider/active",
      "provider/missing-status",
    ]);

    expect(mocks.ensureServer).toHaveBeenCalledWith(4096);
  });

  it("ignores malformed provider payloads", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(true);
    mocks.providerList.mockResolvedValue({
      data: {
        connected: "provider",
        all: [{ id: 42, models: [] }],
      },
    });

    await expect(getAvailableModels(4096)).resolves.toEqual([]);
  });

  it("keeps valid models when nullable fields and malformed siblings are present", async () => {
    const { getAvailableModels } = await import("./client.js");
    mocks.isServerRunning.mockResolvedValue(true);
    mocks.providerList.mockResolvedValue({
      data: {
        connected: ["provider"],
        all: [
          null,
          {
            id: "provider",
            models: {
              invalid: null,
              active: { id: "active", status: null },
            },
          },
        ],
      },
    });

    await expect(getAvailableModels(4096)).resolves.toEqual(["provider/active"]);
  });
});
