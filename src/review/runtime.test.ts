import { describe, expect, it, vi } from "vitest";
import { inspectReviewRuntimes } from "./runtime.js";

describe("inspectReviewRuntimes", () => {
  it("reports installed runtimes without provider or authentication work", async () => {
    const getOpenCodeVersion = vi.fn(async () => "1.2.3");
    const getCodexVersion = vi.fn(async () => null);
    const getCursorVersion = vi.fn(async () => "2026.08.11-e8db854");

    await expect(
      inspectReviewRuntimes({ getOpenCodeVersion, getCodexVersion, getCursorVersion }),
    ).resolves.toEqual({
      opencode: { available: true, version: "1.2.3" },
      codex: { available: false, version: null },
      cursor: { available: true, version: "2026.08.11-e8db854" },
    });
    expect(getOpenCodeVersion).toHaveBeenCalledOnce();
    expect(getCodexVersion).toHaveBeenCalledOnce();
    expect(getCursorVersion).toHaveBeenCalledOnce();
  });
});
