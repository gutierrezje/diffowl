import { z } from "zod";

/**
 * Values entering the OpenCode adapter are parsed by the schema that owns the
 * relevant wire contract before the rest of the pipeline consumes them.
 */
export const BoundaryValueSchema = z.unknown();
export type BoundaryValue = z.input<typeof BoundaryValueSchema>;

const OpenCodePropertiesSchema = z.object({}).passthrough();

export const OpenCodePayloadSchema = z
  .object({
    type: z.string(),
    properties: OpenCodePropertiesSchema,
  })
  .passthrough();
export type OpenCodePayloadInput = z.input<typeof OpenCodePayloadSchema>;

export const OpenCodeEventEnvelopeSchema = z.object({ payload: BoundaryValueSchema }).passthrough();
export type OpenCodeEventInput = z.input<typeof OpenCodeEventEnvelopeSchema> | null;

export const MessagePartSchema = z
  .object({
    sessionID: z.string(),
    type: z.string().optional(),
    tool: BoundaryValueSchema.optional(),
    state: BoundaryValueSchema.optional(),
    id: BoundaryValueSchema.optional(),
    messageID: BoundaryValueSchema.optional(),
    text: BoundaryValueSchema.optional(),
  })
  .passthrough();

export const AssistantInfoSchema = z
  .object({
    role: z.literal("assistant"),
    sessionID: z.string(),
    id: z.string(),
    error: BoundaryValueSchema.optional(),
  })
  .passthrough();

export const SessionStatusSchema = z
  .object({
    type: z.string(),
    message: BoundaryValueSchema.optional(),
  })
  .passthrough();

export const SessionMessageSchema = z
  .object({
    info: z
      .object({
        role: z.string(),
        id: BoundaryValueSchema.optional(),
        error: BoundaryValueSchema.optional(),
      })
      .passthrough()
      .optional(),
    parts: z.array(BoundaryValueSchema).optional(),
  })
  .passthrough();

export const SessionMessagesResponseSchema = z
  .object({ data: z.array(BoundaryValueSchema).optional() })
  .passthrough();
export type SessionMessagesResponseInput = z.input<typeof SessionMessagesResponseSchema>;

export const SessionResponseSchema = z
  .object({ data: BoundaryValueSchema.optional() })
  .passthrough();
export type SessionResponseInput = z.input<typeof SessionResponseSchema>;

export const ErrorDetailsSchema = z
  .object({
    data: BoundaryValueSchema.optional(),
    message: BoundaryValueSchema.optional(),
    name: BoundaryValueSchema.optional(),
  })
  .passthrough();

export const ErrorValueSchema = z.union([z.string(), ErrorDetailsSchema]);
export type ErrorValue = z.output<typeof ErrorValueSchema>;

export function nonEmptyString(value: BoundaryValue): string | undefined {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || parsed.data.trim() === "") return undefined;
  return parsed.data;
}
