import { readFileSync } from "node:fs";

export interface Settings {
  apiBaseUrl: string;
  timeoutMs: number;
  retries: number;
}

const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: "https://api.example.com",
  timeoutMs: 5_000,
  retries: 2,
};

export function loadSettings(path: string): Settings {
  const raw = readSettingsFile(path);
  if (raw === undefined) {
    // A missing settings file is a supported first-run state.
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...parseSettings(raw, path) };
}

function readSettingsFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export function parseSettings(raw: string, path: string): Partial<Settings> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid settings JSON at ${path}: ${(err as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Settings at ${path} must be a JSON object.`);
  }
  return value as Partial<Settings>;
}
