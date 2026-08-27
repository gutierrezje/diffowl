import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z, ZodError } from "zod";
import { getSharedDiffOwlDir } from "./git/state-root.js";
import {
  BackendModelSelectionSchema,
  formatReviewBackend,
  OpenCodeModelSchema,
  parseBackendModel,
  parseReasoningVariant,
  ReviewBackendSchema,
  type BackendModelSelection,
  type ReviewBackend,
} from "./review/backend-selection.js";

const PREFERENCES_FILENAME = "preferences.yml";
const MODEL_PREFERENCE_ORDER = {
  opencode: 0,
  codex: 1,
} satisfies Record<ReviewBackend, number>;
const LegacyPreferenceFileSchema = z.object({ model: OpenCodeModelSchema }).strict();
const CurrentPreferenceFileSchema = z
  .object({
    backend: ReviewBackendSchema.optional(),
    models: z.array(BackendModelSelectionSchema).default([]),
  })
  .strict()
  .superRefine((preference, context) => {
    const seen = new Set<ReviewBackend>();
    for (const [index, selection] of preference.models.entries()) {
      if (seen.has(selection.backend)) {
        context.addIssue({
          code: "custom",
          message: `duplicate ${selection.backend} model preference`,
          path: ["models", index, "backend"],
        });
      }
      seen.add(selection.backend);
    }
  });

export type ReviewPreferences =
  | { kind: "none"; models: [] }
  | {
      kind: "legacy";
      selectedBackend: "opencode";
      models: [{ backend: "opencode"; model: string }];
    }
  | {
      kind: "current";
      selectedBackend?: ReviewBackend;
      models: BackendModelSelection[];
    };

type CurrentReviewPreferences = Omit<Extract<ReviewPreferences, { kind: "current" }>, "kind">;
type CurrentPreferenceFile = z.output<typeof CurrentPreferenceFileSchema>;

export async function loadReviewPreferences(): Promise<ReviewPreferences> {
  const path = await getReviewPreferencesPath();
  let value: unknown;
  try {
    value = parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && isMissingFile(error)) return { kind: "none", models: [] };
    const failure = error instanceof Error ? error : new Error(String(error));
    throw preferenceError(path, failure);
  }

  const legacy = LegacyPreferenceFileSchema.safeParse(value);
  if (legacy.success) {
    return {
      kind: "legacy",
      selectedBackend: "opencode",
      models: [{ backend: "opencode", model: legacy.data.model }],
    };
  }

  try {
    const current = CurrentPreferenceFileSchema.parse(value);
    const preferences: CurrentReviewPreferences = {
      models: canonicalizeModels(current.models),
    };
    if (current.backend !== undefined) preferences.selectedBackend = current.backend;
    return { kind: "current", ...preferences };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw preferenceError(path, failure);
  }
}

export async function saveReviewBackendPreference(backend: ReviewBackend): Promise<string> {
  const current = toCurrentPreferences(await loadReviewPreferences());
  current.selectedBackend = backend;
  return writeReviewPreferences(current);
}

export async function resetReviewBackendPreference(): Promise<void> {
  const current = toCurrentPreferences(await loadReviewPreferences());
  delete current.selectedBackend;
  await writeReviewPreferences(current);
}

export async function saveReviewBackendModel(
  backend: ReviewBackend,
  model: string,
): Promise<string> {
  const parsedModel = parseBackendModel(backend, model);
  const preferences = await loadReviewPreferences();
  const current = toCurrentPreferences(preferences);
  if (preferences.kind === "legacy") {
    delete current.selectedBackend;
  }
  const previous = current.models.find((selection) => selection.backend === backend);
  const nextSelection =
    previous?.model === parsedModel ? previous : { backend, model: parsedModel };
  current.models = [
    ...current.models.filter((selection) => selection.backend !== backend),
    nextSelection,
  ];
  return writeReviewPreferences(current);
}

export async function resetReviewBackendModel(backend: ReviewBackend): Promise<void> {
  const preferences = await loadReviewPreferences();
  const current = toCurrentPreferences(preferences);
  if (preferences.kind === "legacy") {
    delete current.selectedBackend;
  }
  current.models = current.models.filter((selection) => selection.backend !== backend);
  await writeReviewPreferences(current);
}

export async function saveReviewBackendReasoning(
  backend: ReviewBackend,
  variant: string,
): Promise<string> {
  const parsedVariant = parseReasoningVariant(variant);
  const preferences = await loadReviewPreferences();
  const current = toCurrentPreferences(preferences);
  if (preferences.kind === "legacy") {
    delete current.selectedBackend;
  }
  const selection = current.models.find((candidate) => candidate.backend === backend);
  if (selection === undefined) {
    throw new Error(
      `No ${formatReviewBackend(backend)} model selected. Run \`diffowl model <${
        backend === "opencode" ? "provider/model" : "model-id"
      }>\` first.`,
    );
  }

  current.models = current.models.map((candidate) => {
    if (candidate.backend !== backend) return candidate;
    if (parsedVariant === "auto") {
      const { reasoning: _reasoning, ...withoutReasoning } = candidate;
      return withoutReasoning;
    }
    return { ...candidate, reasoning: { variant: parsedVariant } };
  });
  return writeReviewPreferences(current);
}

export async function resetReviewBackendReasoning(backend: ReviewBackend): Promise<void> {
  const preferences = await loadReviewPreferences();
  const current = toCurrentPreferences(preferences);
  if (preferences.kind === "legacy") {
    delete current.selectedBackend;
  }
  current.models = current.models.map((candidate) => {
    if (candidate.backend !== backend) return candidate;
    const { reasoning: _reasoning, ...withoutReasoning } = candidate;
    return withoutReasoning;
  });
  await writeReviewPreferences(current);
}

export async function getReviewPreferencesPath(): Promise<string> {
  return join(await getSharedDiffOwlDir(), PREFERENCES_FILENAME);
}

function toCurrentPreferences(preferences: ReviewPreferences): CurrentReviewPreferences {
  switch (preferences.kind) {
    case "none":
      return { models: [] };
    case "legacy":
      return {
        selectedBackend: preferences.selectedBackend,
        models: [...preferences.models],
      };
    case "current":
      const current: CurrentReviewPreferences = { models: [...preferences.models] };
      if (preferences.selectedBackend !== undefined) {
        current.selectedBackend = preferences.selectedBackend;
      }
      return current;
  }
}

async function writeReviewPreferences(preferences: CurrentReviewPreferences): Promise<string> {
  const path = await getReviewPreferencesPath();
  const models = canonicalizeModels(preferences.models);
  if (preferences.selectedBackend === undefined && models.length === 0) {
    await rm(path, { force: true });
    return path;
  }

  const dir = await getSharedDiffOwlDir();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const input: CurrentPreferenceFile = { models };
  if (preferences.selectedBackend !== undefined) input.backend = preferences.selectedBackend;
  const value = CurrentPreferenceFileSchema.parse(input);
  await mkdir(dir, { recursive: true });
  await writeFile(temporaryPath, stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  return path;
}

function canonicalizeModels(models: BackendModelSelection[]): BackendModelSelection[] {
  return [...models].sort(
    (left, right) => MODEL_PREFERENCE_ORDER[left.backend] - MODEL_PREFERENCE_ORDER[right.backend],
  );
}

function preferenceError(path: string, error: Error): Error {
  const message =
    error instanceof ZodError
      ? error.issues
          .map((issue) => `${issue.path.join(".") || "preferences"}: ${issue.message}`)
          .join("; ")
      : error.message;
  return new Error(`Failed to load ${path}: ${message}`);
}

function isMissingFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}
