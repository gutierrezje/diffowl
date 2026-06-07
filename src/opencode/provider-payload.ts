import { z } from "zod";

const ProviderModelSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    reasoning: z.boolean().optional(),
    capabilities: z.object({ reasoning: z.boolean().optional() }).optional(),
    variants: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ProviderSchema = z
  .object({
    id: z.string(),
    models: z.record(z.string(), ProviderModelSchema).optional(),
  })
  .passthrough();

const ProviderPayloadSchema = z
  .object({
    connected: z.array(z.string()).optional().default([]),
    all: z.array(ProviderSchema).optional().default([]),
  })
  .passthrough();

export type ProviderPayload = z.infer<typeof ProviderPayloadSchema>;

export function parseProviderPayload(response: unknown): ProviderPayload | undefined {
  if (!response || typeof response !== "object") return undefined;
  return ProviderPayloadSchema.safeParse((response as { data?: unknown }).data).data;
}
