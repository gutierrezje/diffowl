import { z } from "zod";

export const ReviewOperationIdSchema = z.string().startsWith("op_").brand<"ReviewOperationId">();
export const ReviewExecutionIdSchema = z.string().startsWith("exe_").brand<"ReviewExecutionId">();
export const ReviewIdSchema = z.string().startsWith("rev_").brand<"ReviewId">();
export const FindingIdSchema = z.string().startsWith("fnd_").brand<"FindingId">();
export const ReviewerIdSchema = z.string().min(1).brand<"ReviewerId">();

export type ReviewOperationId = z.output<typeof ReviewOperationIdSchema>;
export type ReviewExecutionId = z.output<typeof ReviewExecutionIdSchema>;
export type ReviewId = z.output<typeof ReviewIdSchema>;
export type FindingId = z.output<typeof FindingIdSchema>;
export type ReviewerId = z.output<typeof ReviewerIdSchema>;
