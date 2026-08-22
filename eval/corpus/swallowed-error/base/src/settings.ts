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
  } catch (cause) {
    if (isMissingSettingsFileError(cause)) {
      return undefined;
    }
    throw cause;
  }
}

export function parseSettings(raw: string, path: string): Partial<Settings> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Invalid settings JSON at ${path}: ${describeError(cause)}`);
  }
  if (!isSettingsObject(value)) {
    throw new Error(`Settings at ${path} must be a JSON object.`);
  }
  return value;
}

function isMissingSettingsFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isSettingsObject(cause: unknown): cause is Partial<Settings> {
  if (cause === null || typeof cause !== "object" || Array.isArray(cause)) {
    return false;
  }
  if ("apiBaseUrl" in cause && typeof cause.apiBaseUrl !== "string") {
    return false;
  }
  if ("timeoutMs" in cause && typeof cause.timeoutMs !== "number") {
    return false;
  }
  if ("retries" in cause && typeof cause.retries !== "number") {
    return false;
  }
  return true;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
