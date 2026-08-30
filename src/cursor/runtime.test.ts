import { describe, expect, it, vi } from "vitest";
import { getInstalledCursorVersion } from "./runtime.js";

describe("getInstalledCursorVersion", () => {
  it("reads a version without starting ACP or checking authentication", async () => {
    const execute = vi.fn(async () => ({ stdout: "2026.08.11-e8db854\n" }));

    await expect(getInstalledCursorVersion(execute)).resolves.toBe("2026.08.11-e8db854");
    expect(execute).toHaveBeenCalledWith("cursor-agent", ["--version"], { timeout: 5_000 });
  });

  it("returns null when the runtime is missing", async () => {
    await expect(
      getInstalledCursorVersion(vi.fn(async () => Promise.reject(new Error("ENOENT")))),
    ).resolves.toBeNull();
  });
});
