import { describe, expect, it, vi } from "vitest";
import { getInstalledCodexVersion } from "./runtime.js";

describe("getInstalledCodexVersion", () => {
  it("reads a version without starting App Server or checking authentication", async () => {
    const execute = vi.fn(async () => ({ stdout: "codex-cli 0.147.0\n" }));

    await expect(getInstalledCodexVersion(execute)).resolves.toBe("0.147.0");
    expect(execute).toHaveBeenCalledWith("codex", ["--version"], { timeout: 5_000 });
  });

  it("returns null when the runtime is missing or does not report a version", async () => {
    await expect(
      getInstalledCodexVersion(vi.fn(async () => Promise.reject(new Error("ENOENT")))),
    ).resolves.toBeNull();
    await expect(getInstalledCodexVersion(vi.fn(async () => ({ stdout: "" })))).resolves.toBeNull();
  });
});
