import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { ModelSchema } from "./config.js";
import { getSharedDiffOwlDir } from "./git/state-root.js";

const ModelPreferenceSchema = z.object({ model: ModelSchema }).strict();
const PREFERENCES_FILENAME = "preferences.yml";

export async function loadModelPreference(): Promise<string | undefined> {
  const path = join(await getSharedDiffOwlDir(), PREFERENCES_FILENAME);
  try {
    return ModelPreferenceSchema.parse(parse(await readFile(path, "utf8"))).model;
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${path}: ${message}`);
  }
}

export async function saveModelPreference(model: string): Promise<string> {
  const dir = await getSharedDiffOwlDir();
  const path = join(dir, PREFERENCES_FILENAME);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const preference = ModelPreferenceSchema.parse({ model });
  await mkdir(dir, { recursive: true });
  await writeFile(temporaryPath, stringify(preference), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  return path;
}

export async function resetModelPreference(): Promise<void> {
  await rm(join(await getSharedDiffOwlDir(), PREFERENCES_FILENAME), { force: true });
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
