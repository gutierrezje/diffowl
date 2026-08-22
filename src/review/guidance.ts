import { z } from "zod";
import { getOpenCodeFailureGuidance } from "../opencode/guidance.js";
import type { ReviewBackend } from "./backend-selection.js";

const RpcFailureSchema = z.object({
  rpcError: z.object({ message: z.string() }),
});

export function getReviewBackendFailureGuidance<Failure>(
  backend: ReviewBackend,
  error: Failure,
): string[] {
  const message = searchableErrorText(error);
  if (backend === "opencode") return getOpenCodeFailureGuidance(message);

  const normalized = message.toLowerCase();
  if (
    normalized.includes("executable was not found") ||
    normalized.includes("command not found") ||
    normalized.includes("enoent")
  ) {
    return [
      "Codex runtime is not installed.",
      "Install the Codex CLI and ensure `codex` is on PATH, then retry.",
    ];
  }
  if (normalized.includes("not authenticated") || normalized.includes("authentication")) {
    return ["Codex authentication is missing.", "Open `codex`, sign in with ChatGPT, then retry."];
  }
  if (
    normalized.includes("protocol") ||
    normalized.includes("compatibility") ||
    normalized.includes("generation failed")
  ) {
    return [
      "Codex runtime is incompatible with this DiffOwl adapter.",
      "Update the Codex CLI, then retry. If the failure remains, install a supported Codex CLI version.",
    ];
  }
  if (
    normalized.includes("model") &&
    (normalized.includes("unsupported") ||
      normalized.includes("unknown") ||
      normalized.includes("not found") ||
      normalized.includes("invalid"))
  ) {
    return [
      "Codex rejected the selected model.",
      "Run `codex` to confirm an available model, then save it with `diffowl model <model-id>`.",
    ];
  }
  return ["Codex review failed. Run `codex` directly to verify the local runtime, then retry."];
}

function searchableErrorText<Failure>(error: Failure): string {
  const primary = error instanceof Error ? error.message : String(error);
  const parsed = RpcFailureSchema.safeParse(error);
  return parsed.success ? `${primary}\n${parsed.data.rpcError.message}` : primary;
}
