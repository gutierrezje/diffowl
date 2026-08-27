import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveReasoningVariant } from "./client.js";
import { listAvailableModels } from "./models.js";
import { parseProviderPayload, type ProviderResponseInput } from "./provider-payload.js";

type ProviderClient = Parameters<typeof resolveReasoningVariant>[0];

describe("provider payload contracts", () => {
  it("discovers active Codex models and preserves reasoning variants", async () => {
    const response = await readFixture("provider-list-codex.json");
    const payload = parseProviderPayload(response);

    expect(listAvailableModels(payload)).toEqual(["openai/gpt-5-codex"]);
    expect(payload?.all[0]?.models?.["gpt-5-codex"]).toMatchObject({
      id: "gpt-5-codex",
      capabilities: { reasoning: true },
      variants: {
        low: {},
        medium: {},
        high: {},
        xhigh: {},
      },
    });
    await expect(
      resolveReasoningVariant(providerClient(response), "openai", "gpt-5-codex", "xhigh"),
    ).resolves.toEqual({ variant: "xhigh", diagnostics: [] });
  });

  it("discovers only connected GitHub Copilot models", async () => {
    const response = await readFixture("provider-list-github-copilot.json");
    const payload = parseProviderPayload(response);

    expect(listAvailableModels(payload)).toEqual([
      "github-copilot/claude-sonnet-4",
      "github-copilot/gpt-4.1",
    ]);
    expect(payload?.all[0]?.models?.["gpt-4.1"]?.reasoning).toBe(false);
    await expect(
      resolveReasoningVariant(providerClient(response), "github-copilot", "gpt-4.1", "high"),
    ).resolves.toEqual({
      diagnostics: [
        'Reasoning variant "high" was requested, but github-copilot/gpt-4.1 does not advertise reasoning support; continuing with provider default. Remove the one-review `--reasoning` override or run `diffowl reasoning --reset` to clear the saved preference.',
      ],
    });
  });
});

function providerClient(response: ProviderResponseInput): ProviderClient {
  return {
    provider: {
      list: async () => response,
    },
  };
}

async function readFixture(name: string): Promise<ProviderResponseInput> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf-8"));
}
