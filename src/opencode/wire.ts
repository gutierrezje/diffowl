import { z } from "zod";

/**
 * Values entering the OpenCode adapter are parsed by the schema that owns the
 * relevant wire contract before the rest of the pipeline consumes them.
 */
export type BoundaryValue =
  | string
  | number
  | boolean
  | null
  | BoundaryValue[]
  | { readonly [key: string]: BoundaryValue };

export const BoundaryValueSchema: z.ZodType<BoundaryValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(BoundaryValueSchema),
    z.record(z.string(), BoundaryValueSchema),
  ]),
);

const OpenCodePropertiesSchema = z.record(z.string(), BoundaryValueSchema);

export const OpenCodePayloadSchema = z.object({
  type: z.string(),
  properties: OpenCodePropertiesSchema,
});
export type OpenCodePayloadInput = z.input<typeof OpenCodePayloadSchema>;
export type OpenCodePayload = z.output<typeof OpenCodePayloadSchema>;

export const OpenCodeEventEnvelopeSchema = z.object({ payload: BoundaryValueSchema });
export type OpenCodeEventInput = z.input<typeof OpenCodeEventEnvelopeSchema> | null;

export const MessagePartSchema = z.object({
  sessionID: z.string(),
  type: z.string().optional(),
  tool: BoundaryValueSchema.optional(),
  state: BoundaryValueSchema.optional(),
  id: BoundaryValueSchema.optional(),
  messageID: BoundaryValueSchema.optional(),
  text: BoundaryValueSchema.optional(),
});

export const AssistantInfoSchema = z.object({
  role: z.literal("assistant"),
  sessionID: z.string(),
  id: z.string(),
  error: BoundaryValueSchema.optional(),
  cost: BoundaryValueSchema.optional(),
  tokens: BoundaryValueSchema.optional(),
});

export const SessionStatusSchema = z.object({
  type: z.string(),
  message: BoundaryValueSchema.optional(),
});

export const SessionMessageSchema = z.object({
  info: z
    .object({
      role: z.string(),
      id: BoundaryValueSchema.optional(),
      error: BoundaryValueSchema.optional(),
    })
    .optional(),
  parts: z.array(BoundaryValueSchema).optional(),
});

export const SessionMessagesResponseSchema = z.object({
  data: z.array(BoundaryValueSchema).optional(),
});
export type SessionMessagesResponseInput = z.input<typeof SessionMessagesResponseSchema>;

export const SessionResponseSchema = z.object({ data: BoundaryValueSchema.optional() });
export type SessionResponseInput = z.input<typeof SessionResponseSchema>;

export const ErrorDetailsSchema = z.object({
  data: BoundaryValueSchema.optional(),
  message: BoundaryValueSchema.optional(),
  name: BoundaryValueSchema.optional(),
});

export const ErrorValueSchema = z.union([z.string(), ErrorDetailsSchema]);
export type ErrorValue = z.output<typeof ErrorValueSchema>;

export function nonEmptyString(value: BoundaryValue | undefined): string | undefined {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || parsed.data.trim() === "") return undefined;
  return parsed.data;
}
