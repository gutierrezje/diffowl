import type { ReviewJsonStatus } from "../output/json.js";

export function resolveGateEnabled(cliFlag: boolean, configEnabled: boolean): boolean {
  return cliFlag || configEnabled;
}

export function decideGateExit(
  status: ReviewJsonStatus,
  enabled: boolean,
  hook: boolean,
): 0 | 1 {
  if (hook) return 0;
  switch (status) {
    case "open":
      return enabled ? 1 : 0;
    case "advisory":
    case "resolved":
    case "skipped":
      return 0;
    default: {
      const _exhaustive: never = status;
      throw new Error(`unexpected review status: ${String(_exhaustive)}`);
    }
  }
}
