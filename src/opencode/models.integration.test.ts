import { describe, expect, it } from "vitest";
import { getAvailableModels } from "./models.js";

describe.skipIf(process.env["DIFFOWL_INTEGRATION"] !== "1")("OpenCode model integration", () => {
  it("discovers configured models from a live OpenCode server", async () => {
    const port = Number.parseInt(process.env["DIFFOWL_OPENCODE_PORT"] ?? "4096", 10);
    const models = await getAvailableModels(port, { autoStart: false });

    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual([...models].sort());
    expect(models.every((model) => model.includes("/"))).toBe(true);
  });
});
