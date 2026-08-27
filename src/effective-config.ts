import {
  DEFAULT_REASONING_EFFORT,
  loadConfigWithDiagnostics,
  type DiffOwlConfig,
  type ReasoningEffort,
} from "./config.js";
import { loadReviewPreferences, type ReviewPreferences } from "./review-preference.js";
import {
  formatReviewBackend,
  parseBackendModel,
  parseReviewBackend,
  type BackendModelSelection,
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
  warnings: string[];
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
  const loaded = await loadConfigWithDiagnostics();
  const config = loaded.config;
  const legacyReasoningEffort = loaded.diagnostics.find(
    (diagnostic) => diagnostic.kind === "legacy-reasoning",
  )?.effort;
  const directBackend =
    overrides.backend === undefined ? undefined : parseReviewBackend(overrides.backend);
  const environmentModel = env["DIFFOWL_MODEL"]?.trim() || undefined;

  if (directBackend !== undefined && overrides.model !== undefined) {
    const requestedModel = parseBackendModel(directBackend, overrides.model);
    const { preferences, warnings } = await loadExplicitReviewPreferences();
    config.model = requestedModel;
    return effectiveConfig(
      config,
      {
        backend: directBackend,
        requestedModel,
        source: { backend: "command", model: "command" },
      },
      legacyReasoningEffort,
      savedReasoningVariant(preferences, directBackend, requestedModel),
      warnings,
    );
  }
  if (
    directBackend !== undefined &&
    environmentModel !== undefined &&
    overrides.model === undefined
  ) {
    const requestedModel = parseBackendModel(directBackend, environmentModel);
    const { preferences, warnings } = await loadExplicitReviewPreferences();
    config.model = requestedModel;
    return effectiveConfig(
      config,
      {
        backend: directBackend,
        requestedModel,
        source: { backend: "command", model: "environment" },
      },
      legacyReasoningEffort,
      savedReasoningVariant(preferences, directBackend, requestedModel),
      warnings,
    );
  }

  const preferences = await loadReviewPreferences();
  const { backend, source: backendSource } = resolveReviewBackendPreference(
    preferences,
    directBackend,
  );
  if (environmentModel !== undefined && overrides.model === undefined) {
    const requestedModel = parseBackendModel(backend, environmentModel);
    config.model = requestedModel;
    return effectiveConfig(
      config,
      {
        backend,
        requestedModel,
        source: { backend: backendSource, model: "environment" },
      },
      legacyReasoningEffort,
      savedReasoningVariant(preferences, backend, requestedModel),
    );
  }

  if (overrides.model !== undefined) {
    const requestedModel = parseBackendModel(backend, overrides.model);
    config.model = requestedModel;
    return effectiveConfig(
      config,
      {
        backend,
        requestedModel,
        source: { backend: backendSource, model: "command" },
      },
      legacyReasoningEffort,
      savedReasoningVariant(preferences, backend, requestedModel),
    );
  }

  const modelCandidate = savedModel(preferences, backend);

  if (modelCandidate === undefined) {
    throw new MissingModelError(backend);
  }

  const requestedModel = parseBackendModel(backend, modelCandidate.model);
  config.model = requestedModel;
  return effectiveConfig(
    config,
    {
      backend,
      requestedModel,
      source: { backend: backendSource, model: modelCandidate.source },
    },
    legacyReasoningEffort,
    modelCandidate.selection.reasoning?.variant,
  );
}

function effectiveConfig(
  config: DiffOwlConfig,
  selection: ReviewSelection,
  legacyReasoningEffort: ReasoningEffort | undefined,
  savedReasoningVariant?: string,
  additionalWarnings: string[] = [],
): EffectiveConfig {
  config.reasoning.effort =
    savedReasoningVariant ?? legacyReasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const warnings = [...additionalWarnings];
  if (legacyReasoningEffort !== undefined) {
    warnings.push(formatLegacyReasoningWarning(legacyReasoningEffort, savedReasoningVariant));
  }
  return {
    config,
    selection,
    warnings,
  };
}

async function loadExplicitReviewPreferences(): Promise<{
  preferences: ReviewPreferences;
  warnings: string[];
}> {
  try {
    return { preferences: await loadReviewPreferences(), warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      preferences: { kind: "none", models: [] },
      warnings: [
        `Invalid .diffowl/preferences.yml was ignored because backend and model were selected outside the preferences file. Saved reasoning was not applied. Fix or remove the preferences file. ${message}`,
      ],
    };
  }
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
): { model: string; source: "local" | "legacy"; selection: BackendModelSelection } | undefined {
  const selection = preferences.models.find((candidate) => candidate.backend === backend);
  if (selection === undefined) return undefined;
  return {
    model: selection.model,
    source: preferences.kind === "legacy" ? "legacy" : "local",
    selection,
  };
}

function savedReasoningVariant(
  preferences: ReviewPreferences,
  backend: ReviewBackend,
  model: string,
): string | undefined {
  const selection = preferences.models.find(
    (candidate) => candidate.backend === backend && candidate.model === model,
  );
  return selection !== undefined && "reasoning" in selection
    ? selection.reasoning?.variant
    : undefined;
}

function formatLegacyReasoningWarning(
  effort: ReasoningEffort,
  savedReasoningVariant?: string,
): string {
  if (savedReasoningVariant !== undefined) {
    return `Deprecated .diffowl.yml reasoning.effort "${effort}" is ignored because the selected model already uses reasoning.variant "${savedReasoningVariant}" from .diffowl/preferences.yml. Remove only the deprecated reasoning block from .diffowl.yml; run \`diffowl reasoning --reset\` only if you want the backend default.`;
  }
  if (effort === DEFAULT_REASONING_EFFORT) {
    return 'Deprecated .diffowl.yml reasoning.effort is "auto" (the backend default). Run `diffowl reasoning --reset` to clear any local override in .diffowl/preferences.yml, then remove the deprecated reasoning block from .diffowl.yml.';
  }
  return `Deprecated .diffowl.yml reasoning.effort "${effort}". Run \`diffowl reasoning ${effort}\` to save it in .diffowl/preferences.yml, then remove the deprecated reasoning block from .diffowl.yml.`;
}
