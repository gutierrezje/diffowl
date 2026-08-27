import { z } from "zod";

export const ReviewBackendSchema = z.enum(["opencode", "codex"]);
export const BackendPreferenceSourceSchema = z.enum(["command", "local", "legacy", "default"]);
export const ModelPreferenceSourceSchema = z.enum(["command", "environment", "local", "legacy"]);
export const ReviewPreferenceSourceSchema = z
  .object({
    backend: BackendPreferenceSourceSchema,
    model: ModelPreferenceSourceSchema,
  })
  .strict();
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
export const ReasoningVariantSchema = z
  .string()
  .trim()
  .min(1, "Reasoning variant must not be empty");
const PersistedReasoningVariantSchema = ReasoningVariantSchema.refine(
  (value) => value !== "auto",
  'Reasoning variant "auto" cannot be persisted; run `diffowl reasoning --reset`.',
);
const BackendModelReasoningSchema = z.object({ variant: PersistedReasoningVariantSchema }).strict();

export const BackendModelSelectionSchema = z.discriminatedUnion("backend", [
  z
    .object({
      backend: z.literal("opencode"),
      model: OpenCodeModelSchema,
      reasoning: BackendModelReasoningSchema.optional(),
    })
    .strict(),
  z
    .object({
      backend: z.literal("codex"),
      model: CodexModelSchema,
      reasoning: BackendModelReasoningSchema.optional(),
    })
    .strict(),
]);

export type ReviewBackend = z.output<typeof ReviewBackendSchema>;
export type BackendModelSelection = z.output<typeof BackendModelSelectionSchema>;
export type BackendPreferenceSource = z.output<typeof BackendPreferenceSourceSchema>;
export type ModelPreferenceSource = z.output<typeof ModelPreferenceSourceSchema>;

export type ReviewSelection = {
  backend: ReviewBackend;
  requestedModel: string;
  source: {
    backend: BackendPreferenceSource;
    model: ModelPreferenceSource;
  };
};

export function parseReviewBackend(value: string): ReviewBackend {
  return ReviewBackendSchema.parse(value);
}

export function parseBackendModel(backend: ReviewBackend, value: string): string {
  switch (backend) {
    case "opencode":
      return OpenCodeModelSchema.parse(value);
    case "codex":
      return CodexModelSchema.parse(value);
  }
}

export function parseReasoningVariant(value: string): string {
  return ReasoningVariantSchema.parse(value);
}

export function formatReviewBackend(backend: ReviewBackend): string {
  switch (backend) {
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
  }
}
