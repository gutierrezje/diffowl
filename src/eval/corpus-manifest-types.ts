import { z } from "zod";

export const EvalCorpusManifestSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(z.string().trim().min(1)).min(1),
  frozen_at: z.string().trim().min(1),
  notes: z.string().trim().min(1).optional(),
});

export type EvalCorpusManifest = z.output<typeof EvalCorpusManifestSchema>;

export function parseEvalCorpusManifest(raw: unknown): EvalCorpusManifest {
  return EvalCorpusManifestSchema.parse(raw);
}
