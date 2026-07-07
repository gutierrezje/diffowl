import { loadSettings, type Settings } from "./settings.js";

export interface RequestPlan {
  url: string;
  timeoutMs: number;
  attempts: number;
}

export function planRequest(settingsPath: string, endpoint: string): RequestPlan {
  const settings: Settings = loadSettings(settingsPath);
  return {
    url: `${settings.apiBaseUrl}${endpoint}`,
    timeoutMs: settings.timeoutMs,
    attempts: settings.retries + 1,
  };
}
