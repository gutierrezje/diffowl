import { createOpencodeClient } from "@opencode-ai/sdk";
import { ensureServer, isServerRunning } from "./server.js";
import { parseProviderPayload } from "./provider-payload.js";

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
    if (!payload) return [];
    const modelsList: string[] = [];

    for (const provider of payload.all) {
      // Only include connected providers
      if (!payload.connected.includes(provider.id)) {
        continue;
      }

      if (provider.models) {
        for (const modelKey of Object.keys(provider.models)) {
          const model = provider.models[modelKey];
          if (!model) continue;
          // Only show active models
          if (model.status === "active" || !model.status) {
            modelsList.push(`${provider.id}/${model.id}`);
          }
        }
      }
    }

    return modelsList.sort();
  } catch {
    return [];
  }
}
