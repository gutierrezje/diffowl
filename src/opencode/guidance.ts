import { isQuotaOrRateLimitError } from "./quota.js";

export function getOpenCodeFailureGuidance(message: string): string[] {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("opencode not found") ||
    normalized.includes("opencode: command not found") ||
    (normalized.includes("enoent") && normalized.includes("opencode"))
  ) {
    return [
      "Install OpenCode: npm install --global opencode-ai",
      "Run `opencode`, connect a provider, then retry the DiffOwl command.",
      "Docs: https://opencode.ai/docs/",
    ];
  }

  if (
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("invalid api key") ||
    normalized.includes("missing api key") ||
    /\b(401|403)\b/.test(normalized) ||
    normalized.includes("no active provider") ||
    normalized.includes("no connected provider") ||
    normalized.includes("model not found") ||
    normalized.includes("unknown model")
  ) {
    return [
      "Run `opencode` and connect or re-authenticate a provider.",
      "Confirm a model is available, then retry the DiffOwl command.",
    ];
  }

  if (
    normalized.includes("server is not running") ||
    normalized.includes("failed to start opencode server") ||
    normalized.includes("econnrefused") ||
    normalized.includes("connection refused")
  ) {
    return ["Start the managed server: diffowl server start", "Then retry the DiffOwl command."];
  }

  if (isQuotaOrRateLimitError(normalized)) {
    return [
      "Provider quota or rate limit reached. Wait a few minutes and retry.",
      "If persistent, check your provider dashboard for usage limits and billing.",
      "You can also try a different model: diffowl review --model <model>",
    ];
  }

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return ["Retry with less context: diffowl review --depth shallow"];
  }

  if (
    normalized.includes("node_module_version") ||
    (normalized.includes("better-sqlite3") &&
      normalized.includes("compiled against a different node.js version"))
  ) {
    return [
      "Native module ABI mismatch. Rebuild for your active Node: pnpm rebuild better-sqlite3",
      "Reinstall the hook so it uses the same Node as the CLI: diffowl hook install",
      "Compare the required NODE_MODULE_VERSION with the Hook Node ABI from `diffowl hook install`.",
    ];
  }

  if (
    normalized.includes("session_message.seq") ||
    (normalized.includes("not null constraint failed") && normalized.includes("seq"))
  ) {
    return [
      "OpenCode server version may be stale. Check: diffowl server status",
      "Restart the server: diffowl server stop && diffowl server start",
      "Confirm server and CLI versions match: opencode --version",
    ];
  }

  return [];
}
