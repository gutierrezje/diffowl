import { getInstalledCodexVersion } from "../codex/runtime.js";
import { getInstalledOpencodeVersion } from "../opencode/server.js";
import type { ReviewBackend } from "./backend-selection.js";

export type ReviewRuntimeStatus =
  | { available: true; version: string }
  | { available: false; version: null };

export type ReviewRuntimeStatuses = Record<ReviewBackend, ReviewRuntimeStatus>;

interface ReviewRuntimeDependencies {
  getOpenCodeVersion(): Promise<string | null>;
  getCodexVersion(): Promise<string | null>;
}

const defaultDependencies: ReviewRuntimeDependencies = {
  getOpenCodeVersion: getInstalledOpencodeVersion,
  getCodexVersion: getInstalledCodexVersion,
};

export async function inspectReviewRuntimes(
  dependencies: ReviewRuntimeDependencies = defaultDependencies,
): Promise<ReviewRuntimeStatuses> {
  const [openCodeVersion, codexVersion] = await Promise.all([
    dependencies.getOpenCodeVersion(),
    dependencies.getCodexVersion(),
  ]);
  return {
    opencode:
      openCodeVersion === null
        ? { available: false, version: null }
        : { available: true, version: openCodeVersion },
    codex:
      codexVersion === null
        ? { available: false, version: null }
        : { available: true, version: codexVersion },
  };
}
