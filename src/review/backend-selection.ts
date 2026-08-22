import { z } from "zod";

export const ReviewBackendSchema = z.enum(["opencode", "codex"]);
export const OpenCodeModelSchema = z
  .string()
  .trim()
  .min(1, "OpenCode model must not be empty")
  .regex(/^[^/\s]+\/\S+$/, "OpenCode model must use provider/model format");
export const CodexModelSchema = z
  .string()
  .trim()
  .min(1, "Codex model must not be empty")
  .regex(/^[^/\s]+$/, "Codex model must be a bare model id");

export const BackendModelSelectionSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("opencode"), model: OpenCodeModelSchema }).strict(),
  z.object({ backend: z.literal("codex"), model: CodexModelSchema }).strict(),
]);
const BackendSelectionInputSchema = z.unknown();

export type ReviewBackend = z.output<typeof ReviewBackendSchema>;
export type BackendModelSelection = z.output<typeof BackendModelSelectionSchema>;
export type BackendPreferenceSource = "command" | "local" | "legacy" | "default";
export type ModelPreferenceSource = "command" | "environment" | "local" | "legacy";
type BackendSelectionInput = z.input<typeof BackendSelectionInputSchema>;

export type ReviewSelection = {
  backend: ReviewBackend;
  requestedModel: string;
  source: {
    backend: BackendPreferenceSource;
    model: ModelPreferenceSource;
  };
};

export function parseReviewBackend(value: BackendSelectionInput): ReviewBackend {
  return ReviewBackendSchema.parse(value);
}

export function parseBackendModel(backend: ReviewBackend, value: BackendSelectionInput): string {
  switch (backend) {
    case "opencode":
      return OpenCodeModelSchema.parse(value);
    case "codex":
      return CodexModelSchema.parse(value);
  }
}

export function formatReviewBackend(backend: ReviewBackend): string {
  switch (backend) {
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
  }
}
