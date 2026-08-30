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
  switch (backend) {
    case "opencode":
      return getOpenCodeFailureGuidance(message);
    case "codex":
      return getCodexFailureGuidance(message);
    case "cursor":
      return getCursorFailureGuidance(message);
  }
}

function getCodexFailureGuidance(message: string): string[] {
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

function getCursorFailureGuidance(message: string): string[] {
  const normalized = message.toLowerCase();
  if (normalized.includes("quota or rate limit")) {
    return [
      "Cursor usage limit reached.",
      "Switch to a model available on your Cursor plan or ask your administrator to increase the limit, then retry.",
    ];
  }
  if (
    normalized.includes("executable was not found") ||
    normalized.includes("command not found") ||
    normalized.includes("enoent")
  ) {
    return [
      "Cursor runtime is not installed.",
      "Install the Cursor CLI and ensure `cursor-agent` is on PATH, then retry.",
    ];
  }
  if (normalized.includes("authentication") || normalized.includes("cursor_login")) {
    return [
      "Cursor authentication is missing.",
      "Run `cursor-agent login` on this machine, then retry.",
    ];
  }
  if (normalized.includes("does not advertise model") || normalized.includes("did not select model")) {
    return [
      "Cursor rejected the selected model.",
      "Run `diffowl model --list`, then save an advertised ACP base model with `diffowl model <model-id>`.",
    ];
  }
  if (normalized.includes("protocol") || normalized.includes("incompatible")) {
    return [
      "Cursor runtime is incompatible with this DiffOwl adapter.",
      "Update the Cursor CLI, then retry.",
    ];
  }
  return ["Cursor review failed. Run `cursor-agent` directly to verify the local runtime, then retry."];
}

function searchableErrorText<Failure>(error: Failure): string {
  const primary = error instanceof Error ? error.message : String(error);
  const parsed = RpcFailureSchema.safeParse(error);
  return parsed.success ? `${primary}\n${parsed.data.rpcError.message}` : primary;
}
