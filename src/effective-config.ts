import {
  loadConfigWithDiagnostics,
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
import {
  BACKEND_DEFAULT_REASONING,
  selectReasoningVariant,
  type ReasoningSelection,
  type ReasoningVariant,
} from "./review/reasoning.js";
import type { EffectiveReviewConfig } from "./review/runtime-config.js";

export class MissingModelError extends Error {
  readonly backend: ReviewBackend;

  constructor(backend: ReviewBackend = "opencode", legacyModel?: string) {
    const legacyGuidance =
      legacyModel === undefined
        ? ""
        : ` Legacy .diffowl.yml model "${legacyModel}" is no longer used. To keep it as your OpenCode preference, run \`diffowl backend opencode\` and then \`diffowl model ${legacyModel}\`; then remove model from .diffowl.yml.`;
    super(
      `No model selected for ${formatReviewBackend(backend)}. Run \`diffowl model <${
        backend === "opencode" ? "provider/model" : "model-id"
      }>\`.${legacyGuidance}`,
    );
    this.backend = backend;
  }
}

export type EffectiveConfig = {
  config: EffectiveReviewConfig;
  selection: ReviewSelection;
  reasoning: ReasoningSelection;
  warnings: string[];
};

export type EffectiveReviewOverrides = {
  backend?: string;
  model?: string;
  reasoning?: string;
};

type ResolvedReviewBackendPreference = Pick<ReviewSelection, "backend"> & {
  source: ReviewSelection["source"]["backend"];
};

type ResolvedReviewModel = {
  requestedModel: string;
  source: ReviewSelection["source"]["model"];
};

export async function loadEffectiveReviewConfig(
  overrides: EffectiveReviewOverrides = {},
  env: Record<string, string | undefined> = process.env,
): Promise<EffectiveConfig> {
  const loaded = await loadConfigWithDiagnostics();
  const legacyReasoningEffort = loaded.diagnostics.find(
    (diagnostic) => diagnostic.kind === "legacy-reasoning",
  )?.effort;
  const legacyModel = loaded.diagnostics.find(
    (diagnostic) => diagnostic.kind === "legacy-model",
  )?.model;
  const directBackend =
    overrides.backend === undefined ? undefined : parseReviewBackend(overrides.backend);
  const environmentModel = env["DIFFOWL_MODEL"]?.trim() || undefined;
  const canSelectWithoutPreferences =
    directBackend !== undefined &&
    (overrides.model !== undefined ||
      (overrides.model === undefined && environmentModel !== undefined));
  const loadedPreferences = canSelectWithoutPreferences
    ? await loadExplicitReviewPreferences()
    : { preferences: await loadReviewPreferences(), warnings: [] };
  const { preferences } = loadedPreferences;
  const { backend, source: backendSource } = resolveReviewBackendPreference(
    preferences,
    directBackend,
  );
  const model = resolveReviewModel(
    preferences,
    backend,
    overrides.model,
    environmentModel,
    legacyModel,
  );
  const selection: ReviewSelection = {
    backend,
    requestedModel: model.requestedModel,
    source: { backend: backendSource, model: model.source },
  };
  const savedVariant = savedReasoningVariant(preferences, backend, model.requestedModel);
  const commandReasoning =
    overrides.reasoning === undefined ? undefined : selectReasoningVariant(overrides.reasoning);
  const reasoning =
    commandReasoning ??
    (savedVariant === undefined
      ? legacyReasoningSelection(legacyReasoningEffort)
      : selectReasoningVariant(savedVariant));
  const warnings = [...loadedPreferences.warnings];
  if (legacyModel !== undefined) {
    warnings.push(formatLegacyModelWarning(legacyModel, model.requestedModel));
  }
  if (legacyReasoningEffort !== undefined) {
    warnings.push(
      formatLegacyReasoningWarning(
        legacyReasoningEffort,
        commandReasoning,
        savedVariant,
      ),
    );
  }
  return {
    config: { ...loaded.config, model: model.requestedModel, reasoning },
    selection,
    reasoning,
    warnings,
  };
}

function resolveReviewModel(
  preferences: ReviewPreferences,
  backend: ReviewBackend,
  commandModel: string | undefined,
  environmentModel: string | undefined,
  legacyModel: string | undefined,
): ResolvedReviewModel {
  if (commandModel !== undefined) {
    return { requestedModel: parseBackendModel(backend, commandModel), source: "command" };
  }
  if (environmentModel !== undefined) {
    return { requestedModel: parseBackendModel(backend, environmentModel), source: "environment" };
  }
  const candidate = savedModel(preferences, backend);
  if (candidate === undefined) throw new MissingModelError(backend, legacyModel);
  return {
    requestedModel: parseBackendModel(backend, candidate.model),
    source: candidate.source,
  };
}

function legacyReasoningSelection(effort: ReasoningVariant | undefined): ReasoningSelection {
  if (effort === undefined || effort === "auto") return BACKEND_DEFAULT_REASONING;
  return selectReasoningVariant(effort);
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
  effort: ReasoningVariant,
  commandReasoning: ReasoningSelection | undefined,
  savedReasoningVariant?: string,
): string {
  if (commandReasoning?.kind === "variant") {
    return `Deprecated .diffowl.yml reasoning.effort "${effort}" is ignored because this review uses --reasoning "${commandReasoning.value}". Remove the deprecated reasoning block from .diffowl.yml.`;
  }
  if (savedReasoningVariant !== undefined) {
    return `Deprecated .diffowl.yml reasoning.effort "${effort}" is ignored because the selected model already uses reasoning.variant "${savedReasoningVariant}" from .diffowl/preferences.yml. Remove only the deprecated reasoning block from .diffowl.yml; run \`diffowl reasoning --reset\` only if you want the backend default.`;
  }
  if (effort === "auto") {
    return 'Deprecated .diffowl.yml reasoning.effort is "auto" (the backend default). Run `diffowl reasoning --reset` to clear any local override in .diffowl/preferences.yml, then remove the deprecated reasoning block from .diffowl.yml.';
  }
  return `Deprecated .diffowl.yml reasoning.effort "${effort}". Run \`diffowl reasoning ${effort}\` to save it in .diffowl/preferences.yml, then remove the deprecated reasoning block from .diffowl.yml.`;
}

function formatLegacyModelWarning(legacyModel: string, selectedModel: string): string {
  return `Deprecated .diffowl.yml model "${legacyModel}" is ignored; this review uses "${selectedModel}". To keep the legacy value as your OpenCode preference, run \`diffowl backend opencode\` and then \`diffowl model ${legacyModel}\`; then remove model from .diffowl.yml.`;
}
