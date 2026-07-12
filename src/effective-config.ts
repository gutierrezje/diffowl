import { loadConfig, parseModel, type DiffOwlConfig } from "./config.js";
import { loadModelPreference } from "./model-preference.js";

export type ModelSource = "command" | "environment" | "local" | "project";

export type EffectiveConfig = {
  config: DiffOwlConfig;
  modelSource: ModelSource;
};

export async function loadEffectiveConfig(
  commandModel?: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<EffectiveConfig> {
  const config = await loadConfig();
  const environmentModel = env["DIFFOWL_MODEL"]?.trim() || undefined;

  if (commandModel !== undefined) {
    config.model = parseModel(commandModel);
    return { config, modelSource: "command" };
  }
  if (environmentModel !== undefined) {
    config.model = parseModel(environmentModel);
    return { config, modelSource: "environment" };
  }
  const localModel = await loadModelPreference();
  if (localModel !== undefined) {
    config.model = localModel;
    return { config, modelSource: "local" };
  }
  return { config, modelSource: "project" };
}
