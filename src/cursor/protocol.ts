import { z } from "zod";
import { ReviewUsageSchema } from "../review/usage.js";

export const CursorStartSchema = z
  .object({
    kind: z.literal("start"),
    model: z.string().min(1),
    directory: z.string().min(1),
    storeDirectory: z.string().min(1),
    prompt: z.string().min(1),
  })
  .strict();
export const CursorCancelSchema = z.object({ kind: z.literal("cancel") }).strict();
export const CursorErrorCategorySchema = z.enum([
  "authentication",
  "quota",
  "policy",
  "protocol",
  "provider",
  "validation",
  "teardown",
]);
export const CursorMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtime"), version: z.string().nullable() }).strict(),
  z
    .object({
      kind: z.literal("turn"),
      id: z.string(),
      requestId: z.string().nullable(),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("usage"),
      effectiveModel: z.string().nullable(),
      usage: ReviewUsageSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("session"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("tool"), name: z.string(), status: z.string() }).strict(),
  z.object({ kind: z.literal("activity") }).strict(),
  z
    .object({
      kind: z.literal("validation"),
      outcome: z.enum(["accepted", "retry", "failed"]),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      text: z.string(),
      sessionId: z.string().min(1),
      effectiveModel: z.string().min(1).nullable(),
      usage: ReviewUsageSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      category: CursorErrorCategorySchema,
      message: z.string(),
    })
    .strict(),
]);
export type CursorMessage = z.output<typeof CursorMessageSchema>;
export type CursorErrorCategory = z.output<typeof CursorErrorCategorySchema>;
export const CURSOR_READ_ONLY_TOOLS = ["read", "grep", "glob", "ls"];
