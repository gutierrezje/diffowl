import { z } from "zod";
import type { EvalIdentityKind } from "./score-types.js";

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

/** Plan alias `same-across-steps` normalizes to scorer kind `recognize-same`. */
export const EvalCaseIdentityKindInputSchema = z.enum([
  "recognize-same",
  "keep-distinct",
  "same-across-steps",
]);

export const EvalCaseIdentitySchema = z
  .object({
    kind: EvalCaseIdentityKindInputSchema,
    min_distinct: z.number().int().positive().optional(),
  })
  .strict()
  .transform((identity) => ({
    kind: normalizeEvalIdentityKindInput(identity.kind),
    ...(identity.min_distinct !== undefined ? { min_distinct: identity.min_distinct } : {}),
  }));

export const EvalCaseJsonSchema = z.object({
  id: z.string().trim().min(1),
  category: EvalCaseCategorySchema,
  language: EvalCaseLanguageSchema,
  description: z.string().trim().min(1),
  target: EvalCaseTargetSchema.default("commit"),
  expected: z.array(EvalExpectedFindingSchema).default([]),
  steps: z.array(EvalCaseStepJsonSchema).min(1).optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  identity: EvalCaseIdentitySchema.optional(),
});

export type EvalCaseCategory = z.output<typeof EvalCaseCategorySchema>;
export type EvalCaseLanguage = z.output<typeof EvalCaseLanguageSchema>;
export type EvalCaseTarget = z.output<typeof EvalCaseTargetSchema>;
export type EvalExpectedFinding = z.output<typeof EvalExpectedFindingSchema>;
export type EvalCaseStepJson = z.output<typeof EvalCaseStepJsonSchema>;
export type EvalCaseIdentity = z.output<typeof EvalCaseIdentitySchema>;
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

export function normalizeEvalIdentityKindInput(
  kind: z.input<typeof EvalCaseIdentityKindInputSchema>,
): EvalIdentityKind {
  if (kind === "same-across-steps") {
    return "recognize-same";
  }
  return kind;
}

function resolveIdentityKindFromTags(tags: string[]): EvalIdentityKind | undefined {
  for (const tag of tags) {
    if (tag === "identity:recognize-same" || tag === "recognize-same") {
      return "recognize-same";
    }
    if (tag === "identity:keep-distinct" || tag === "keep-distinct") {
      return "keep-distinct";
    }
  }
  return undefined;
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

  if (!caseJson.identity) {
    return;
  }

  if (caseJson.target !== "commit") {
    throw new Error(
      `Case "${caseJson.id}" with identity expectation requires target "commit", got "${caseJson.target}".`,
    );
  }

  const steps = caseJson.steps ?? [];
  if (steps.length < 2) {
    throw new Error(
      `Case "${caseJson.id}" with identity expectation requires at least two steps.`,
    );
  }

  const tagKind = resolveIdentityKindFromTags(caseJson.tags);
  if (tagKind && tagKind !== caseJson.identity.kind) {
    throw new Error(
      `Case "${caseJson.id}" identity.kind "${caseJson.identity.kind}" conflicts with identity tag "${tagKind}".`,
    );
  }

  if (
    caseJson.identity.kind === "keep-distinct" &&
    caseJson.identity.min_distinct !== undefined &&
    caseJson.identity.min_distinct < 2
  ) {
    throw new Error(
      `Case "${caseJson.id}" identity.min_distinct must be at least 2 when present.`,
    );
  }

  const stepExpectedCounts = steps.map((step) => step.expected?.length ?? 0);
  if (caseJson.identity.kind === "recognize-same") {
    if (stepExpectedCounts.some((count) => count === 0)) {
      throw new Error(
        `Case "${caseJson.id}" recognize-same identity requires expected findings on every step.`,
      );
    }
    const [firstCount, ...restCounts] = stepExpectedCounts;
    if (restCounts.some((count) => count !== firstCount)) {
      throw new Error(
        `Case "${caseJson.id}" recognize-same identity requires equal expected counts across steps.`,
      );
    }
  }
}

/**
 * Findings used for scoring / final-state anchor checks.
 * Prefer top-level `expected` when present so dual-declared cases do not double-count.
 * Otherwise flatten `steps[].expected` (multi-step cases that omit top-level expected).
 */
export function collectEvalCaseExpected(
  evalCase: Pick<EvalCase, "expected" | "steps">,
): EvalExpectedFinding[] {
  if (evalCase.expected.length > 0) {
    return evalCase.expected;
  }
  return evalCase.steps.flatMap((step) => step.expected);
}
