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
  if (backend === "cursor") {
    if (/auth|api.?key|\b401\b|\b403\b/.test(normalized)) {
      return [
        "Cursor SDK authentication is missing or expired.",
        "Run `diffowl cursor login`, or set CURSOR_API_KEY. Cursor CLI login is separate.",
      ];
    }
    if (normalized.includes("model")) {
      return [
        "Check the Cursor model with `diffowl cursor models`, then save it with `diffowl model <model-id>`.",
      ];
    }
    return [
      "Cursor SDK review failed. Check `diffowl cursor status` and the error above, then retry.",
    ];
  }
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
