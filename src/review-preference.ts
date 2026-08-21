import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { getSharedDiffOwlDir } from "./git/state-root.js";
import {
  BackendModelSelectionSchema,
  OpenCodeModelSchema,
  parseBackendModel,
  ReviewBackendSchema,
  type BackendModelSelection,
  type ReviewBackend,
} from "./review/backend-selection.js";

const PREFERENCES_FILENAME = "preferences.yml";
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

export async function loadReviewPreferences(): Promise<ReviewPreferences> {
  const path = await getReviewPreferencesPath();
  let value: unknown;
  try {
    value = parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return { kind: "none", models: [] };
    throw preferenceError(path, error);
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
    return {
      kind: "current",
      ...(current.backend === undefined ? {} : { selectedBackend: current.backend }),
      models: canonicalizeModels(current.models),
    };
  } catch (error) {
    throw preferenceError(path, error);
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
  current.models = [
    ...current.models.filter((selection) => selection.backend !== backend),
    { backend, model: parsedModel },
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

export async function getReviewPreferencesPath(): Promise<string> {
  return join(await getSharedDiffOwlDir(), PREFERENCES_FILENAME);
}

function toCurrentPreferences(preferences: ReviewPreferences): {
  selectedBackend?: ReviewBackend;
  models: BackendModelSelection[];
} {
  switch (preferences.kind) {
    case "none":
      return { models: [] };
    case "legacy":
      return {
        selectedBackend: preferences.selectedBackend,
        models: [...preferences.models],
      };
    case "current":
      return {
        ...(preferences.selectedBackend === undefined
          ? {}
          : { selectedBackend: preferences.selectedBackend }),
        models: [...preferences.models],
      };
  }
}

async function writeReviewPreferences(preferences: {
  selectedBackend?: ReviewBackend;
  models: BackendModelSelection[];
}): Promise<string> {
  const path = await getReviewPreferencesPath();
  const models = canonicalizeModels(preferences.models);
  if (preferences.selectedBackend === undefined && models.length === 0) {
    await rm(path, { force: true });
    return path;
  }

  const dir = await getSharedDiffOwlDir();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const value = CurrentPreferenceFileSchema.parse({
    ...(preferences.selectedBackend === undefined ? {} : { backend: preferences.selectedBackend }),
    models,
  });
  await mkdir(dir, { recursive: true });
  await writeFile(temporaryPath, stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  return path;
}

function canonicalizeModels(models: BackendModelSelection[]): BackendModelSelection[] {
  const order: Record<ReviewBackend, number> = { opencode: 0, codex: 1 };
  return [...models].sort((left, right) => order[left.backend] - order[right.backend]);
}

function preferenceError(path: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to load ${path}: ${message}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
