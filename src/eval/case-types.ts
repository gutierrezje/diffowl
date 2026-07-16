import { z } from "zod";

export const EvalCaseCategorySchema = z.enum(["bug", "clean", "mixed"]);
export const EvalCaseLanguageSchema = z.enum(["typescript"]);
export const EvalCaseTargetSchema = z.enum(["staged", "commit"]);
export const EvalSeveritySchema = z.enum(["error", "warning", "info"]);

export const EvalExpectedFindingSchema = z
  .object({
    file: z.string().trim().min(1),
    line: z.number().int().positive(),
    line_tolerance: z.number().int().nonnegative().default(2),
    min_severity: EvalSeveritySchema.default("warning"),
    must_detect: z.boolean().default(true),
  })
  .strict();

export const EvalCaseStepJsonSchema = z
  .object({
    patchPath: z.string().trim().min(1),
    expected: z.array(EvalExpectedFindingSchema).optional(),
  })
  .strict();

export const EvalCaseJsonSchema = z.object({
  id: z.string().trim().min(1),
  category: EvalCaseCategorySchema,
  language: EvalCaseLanguageSchema,
  description: z.string().trim().min(1),
  target: EvalCaseTargetSchema.default("commit"),
  expected: z.array(EvalExpectedFindingSchema).default([]),
  steps: z.array(EvalCaseStepJsonSchema).min(1).optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
});

export type EvalCaseCategory = z.output<typeof EvalCaseCategorySchema>;
export type EvalCaseLanguage = z.output<typeof EvalCaseLanguageSchema>;
export type EvalCaseTarget = z.output<typeof EvalCaseTargetSchema>;
export type EvalExpectedFinding = z.output<typeof EvalExpectedFindingSchema>;
export type EvalCaseStepJson = z.output<typeof EvalCaseStepJsonSchema>;
export type EvalCaseJson = z.output<typeof EvalCaseJsonSchema>;

export interface EvalCaseStep {
  patchPath: string;
  expected: EvalExpectedFinding[];
}

export interface EvalCase extends Omit<EvalCaseJson, "steps"> {
  dir: string;
  baseDir: string;
  patchPath: string;
  steps: EvalCaseStep[];
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
    for (const [index, step] of (caseJson.steps ?? []).entries()) {
      if ((step.expected?.length ?? 0) > 0) {
        throw new Error(
          `Clean case "${caseJson.id}" step ${index} must not declare expected findings.`,
        );
      }
    }
    return;
  }

  const stepHasExpected = (caseJson.steps ?? []).some((step) => (step.expected?.length ?? 0) > 0);
  if (caseJson.expected.length === 0 && !stepHasExpected) {
    throw new Error(`Case "${caseJson.id}" with category "${caseJson.category}" requires expected findings.`);
  }
}
