import { describe, expect, it, vi } from "vitest";
import { inspectReviewRuntimes } from "./runtime.js";

describe("inspectReviewRuntimes", () => {
  it("reports both installed runtimes without provider or authentication work", async () => {
    const getOpenCodeVersion = vi.fn(async () => "1.2.3");
    const getCodexVersion = vi.fn(async () => null);

    await expect(inspectReviewRuntimes({ getOpenCodeVersion, getCodexVersion })).resolves.toEqual({
      opencode: { available: true, version: "1.2.3" },
      codex: { available: false, version: null },
    });
    expect(getOpenCodeVersion).toHaveBeenCalledOnce();
    expect(getCodexVersion).toHaveBeenCalledOnce();
  });
});
