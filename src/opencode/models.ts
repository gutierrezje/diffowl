import { createOpencodeClient } from "@opencode-ai/sdk";
import { ensureServer, isServerRunning } from "./server.js";
import { parseProviderPayload, type ProviderPayload } from "./provider-payload.js";

/**
 * Get all available models from the OpenCode server.
 */
export async function getAvailableModels(
  port: number,
  options: { autoStart?: boolean } = {},
): Promise<string[]> {
  if (!(await isServerRunning(port))) {
    if (options.autoStart === false) {
      return [];
    }

    try {
      await ensureServer(port);
    } catch {
      return [];
    }
  }

  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
  });

  try {
    const payload = parseProviderPayload(await client.provider.list());
    return listAvailableModels(payload);
  } catch {
    return [];
  }
}

export function listAvailableModels(payload: ProviderPayload | undefined): string[] {
  if (!payload) return [];

  return payload.all
    .filter((provider) => payload.connected.includes(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models ?? {})
        .filter((model) => model.status === "active" || !model.status)
        .map((model) => `${provider.id}/${model.id}`),
    )
    .sort();
}
