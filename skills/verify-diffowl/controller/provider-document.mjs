import { z } from "zod";

const ReviewDocumentSchema = z.object({
  schema_version: z.number().int().min(6),
  review: z.object({
    backend: z.enum(["codex", "opencode"]),
    requested_model: z.string(),
    effective_model: z.string().nullable(),
    target: z.object({ kind: z.enum(["staged", "commit", "last-commit", "base"]) }),
    session_id: z.string(),
    report_path: z.string().nullable(),
  }),
});

export function parseReviewDocument(text) {
  try {
    const parsed = ReviewDocumentSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
