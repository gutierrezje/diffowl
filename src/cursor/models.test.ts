import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAvailableCursorModels } from "./models.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-cursor-agent.mjs", import.meta.url));

describe("getAvailableCursorModels", () => {
  it("discovers ACP base model ids without starting a review session", async () => {
    await expect(
      getAvailableCursorModels({
        command: {
          executable: process.execPath,
          prefixArgs: [fixture],
          env: {
            MOCK_CURSOR_MODE: "model-discovery",
            MOCK_CURSOR_MODEL: "gpt-5.6-luna",
          },
        },
        directory: process.cwd(),
        timeoutMs: 5_000,
        closeTimeoutMs: 500,
      }),
    ).resolves.toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.6-luna", name: "Test model" },
    ]);
  });
});
