import { loadConfig, type DiffOwlConfig } from "./config.js";
import { loadReviewPreferences, type ReviewPreferences } from "./review-preference.js";
import {
  formatReviewBackend,
  parseBackendModel,
  parseReviewBackend,
  type ReviewBackend,
  type ReviewSelection,
} from "./review/backend-selection.js";

export class MissingModelError extends Error {
  readonly backend: ReviewBackend;

  constructor(backend: ReviewBackend = "opencode") {
    super(
      `No model selected for ${formatReviewBackend(backend)}. Run \`diffowl model <${
        backend === "opencode" ? "provider/model" : "model-id"
      }>\`.`,
    );
    this.backend = backend;
  }
}

export type EffectiveConfig = {
  config: DiffOwlConfig;
  selection: ReviewSelection;
};

export type EffectiveReviewOverrides = {
  backend?: string;
  model?: string;
};

type ResolvedReviewBackendPreference = Pick<ReviewSelection, "backend"> & {
  source: ReviewSelection["source"]["backend"];
};

export async function loadEffectiveReviewConfig(
  overrides: EffectiveReviewOverrides = {},
  env: Record<string, string | undefined> = process.env,
): Promise<EffectiveConfig> {
  const config = await loadConfig();
  const directBackend =
    overrides.backend === undefined ? undefined : parseReviewBackend(overrides.backend);
  const environmentModel = env["DIFFOWL_MODEL"]?.trim() || undefined;

  if (directBackend !== undefined && overrides.model !== undefined) {
    const requestedModel = parseBackendModel(directBackend, overrides.model);
    config.model = requestedModel;
    return effectiveConfig(config, {
      backend: directBackend,
      requestedModel,
      source: { backend: "command", model: "command" },
    });
  }
  if (
    directBackend !== undefined &&
    environmentModel !== undefined &&
    overrides.model === undefined
  ) {
    const requestedModel = parseBackendModel(directBackend, environmentModel);
    config.model = requestedModel;
    return effectiveConfig(config, {
      backend: directBackend,
      requestedModel,
      source: { backend: "command", model: "environment" },
    });
  }

  const preferences = await loadReviewPreferences();
  const { backend, source: backendSource } = resolveReviewBackendPreference(
    preferences,
    directBackend,
  );
  if (environmentModel !== undefined && overrides.model === undefined) {
    const requestedModel = parseBackendModel(backend, environmentModel);
    config.model = requestedModel;
    return effectiveConfig(config, {
      backend,
      requestedModel,
      source: { backend: backendSource, model: "environment" },
    });
  }
  const modelCandidate =
    overrides.model === undefined
      ? savedModel(preferences, backend)
      : { model: overrides.model, source: "command" as const };

  if (modelCandidate === undefined) {
    throw new MissingModelError(backend);
  }

  const requestedModel = parseBackendModel(backend, modelCandidate.model);
  config.model = requestedModel;
  return effectiveConfig(config, {
    backend,
    requestedModel,
    source: { backend: backendSource, model: modelCandidate.source },
  });
}

function effectiveConfig(config: DiffOwlConfig, selection: ReviewSelection): EffectiveConfig {
  return { config, selection };
}

export function resolveReviewBackendPreference(
  preferences: ReviewPreferences,
  directBackend?: ReviewBackend,
): ResolvedReviewBackendPreference {
  if (directBackend !== undefined) {
    return { backend: directBackend, source: "command" };
  }
  switch (preferences.kind) {
    case "legacy":
      return { backend: "opencode", source: "legacy" };
    case "current":
      return preferences.selectedBackend === undefined
        ? { backend: "opencode", source: "default" }
        : { backend: preferences.selectedBackend, source: "local" };
    case "none":
      return { backend: "opencode", source: "default" };
  }
}

function savedModel(
  preferences: ReviewPreferences,
  backend: ReviewBackend,
): { model: string; source: "local" | "legacy" } | undefined {
  const selection = preferences.models.find((candidate) => candidate.backend === backend);
  if (selection === undefined) return undefined;
  return {
    model: selection.model,
    source: preferences.kind === "legacy" ? "legacy" : "local",
  };
}
