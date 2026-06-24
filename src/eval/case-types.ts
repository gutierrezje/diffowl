import { z } from "zod";

export const EvalCaseCategorySchema = z.enum(["bug", "clean", "mixed"]);
export const EvalCaseLanguageSchema = z.enum(["typescript"]);
export const EvalCaseTargetSchema = z.enum(["staged", "commit"]);
export const EvalSeveritySchema = z.enum(["error", "warning", "info"]);

export const EvalExpectedFindingSchema = z.object({
  file: z.string().trim().min(1),
  line: z.number().int().positive(),
  line_tolerance: z.number().int().nonnegative().default(2),
  category: z.string().trim().min(1).optional(),
  min_severity: EvalSeveritySchema.default("warning"),
  must_detect: z.boolean().default(true),
});

export const EvalCaseJsonSchema = z.object({
  id: z.string().trim().min(1),
  category: EvalCaseCategorySchema,
  language: EvalCaseLanguageSchema,
  description: z.string().trim().min(1),
  target: EvalCaseTargetSchema.default("commit"),
  expected: z.array(EvalExpectedFindingSchema).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
});

export type EvalCaseCategory = z.output<typeof EvalCaseCategorySchema>;
export type EvalCaseLanguage = z.output<typeof EvalCaseLanguageSchema>;
export type EvalCaseTarget = z.output<typeof EvalCaseTargetSchema>;
export type EvalExpectedFinding = z.output<typeof EvalExpectedFindingSchema>;
export type EvalCaseJson = z.output<typeof EvalCaseJsonSchema>;

export interface EvalCase extends EvalCaseJson {
  dir: string;
  baseDir: string;
  patchPath: string;
}

export interface EvalCorpus {
  dir: string;
  version: string;
  cases: EvalCase[];
}

export interface EvalCaseHashes {
  caseJsonHash: string;
  patchHash: string;
}

export function parseEvalCaseJson(raw: unknown): EvalCaseJson {
  return EvalCaseJsonSchema.parse(raw);
}

export function validateEvalCaseSemantics(caseJson: EvalCaseJson): void {
  if (caseJson.category === "clean") {
    if (caseJson.expected.length > 0) {
      throw new Error(`Clean case "${caseJson.id}" must not declare expected findings.`);
    }
    return;
  }

  if (caseJson.expected.length === 0) {
    throw new Error(`Case "${caseJson.id}" with category "${caseJson.category}" requires expected findings.`);
  }
}
