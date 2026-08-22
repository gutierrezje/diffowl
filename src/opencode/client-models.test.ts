import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as server from "./server.js";
import { getAvailableModels } from "./models.js";

const fetchMock = vi.fn();
const ProviderResponseSchema = z.object({}).passthrough();
type ProviderResponse = z.input<typeof ProviderResponseSchema>;

function useServerState(running: boolean): void {
  vi.spyOn(server, "isServerRunning").mockResolvedValue(running);
}

function useProviderResponse(response: ProviderResponse): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("getAvailableModels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    Reflect.deleteProperty(globalThis, "fetch");
  });

  it("reports a stopped server when autoStart is disabled", async () => {
    useServerState(false);

    await expect(getAvailableModels(4096, { autoStart: false })).rejects.toThrow(
      "OpenCode server is not running",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates server startup failures", async () => {
    useServerState(false);
    vi.spyOn(server, "ensureServer").mockRejectedValue(
      new Error("failed to start OpenCode server"),
    );

    await expect(getAvailableModels(4096)).rejects.toThrow("failed to start OpenCode server");
  });

  it("propagates provider list failures", async () => {
    useServerState(true);
    fetchMock.mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAvailableModels(4096)).rejects.toThrow("connection refused");
  });

  it("returns an empty list when discovery succeeds without connected models", async () => {
    useServerState(true);
    useProviderResponse({ connected: [], all: [] });

    await expect(getAvailableModels(4096)).resolves.toEqual([]);
  });

  it("starts OpenCode by default before listing models", async () => {
    useServerState(false);
    vi.spyOn(server, "ensureServer").mockResolvedValue("http://127.0.0.1:4096");
    useProviderResponse({
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
    });

    await expect(getAvailableModels(4096)).resolves.toEqual([
      "provider/active",
      "provider/missing-status",
    ]);

    expect(server.ensureServer).toHaveBeenCalledWith(4096);
  });

  it("ignores malformed provider payloads", async () => {
    useServerState(true);
    useProviderResponse({
      connected: "provider",
      all: [{ id: 42, models: [] }],
    });

    await expect(getAvailableModels(4096)).resolves.toEqual([]);
  });

  it("keeps valid models when nullable fields and malformed siblings are present", async () => {
    useServerState(true);
    useProviderResponse({
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
    });

    await expect(getAvailableModels(4096)).resolves.toEqual(["provider/active"]);
  });
});
