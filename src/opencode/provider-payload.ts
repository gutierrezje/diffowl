import { z } from "zod";
import { BoundaryValueSchema } from "./wire.js";

const ProviderModelSchema = z
  .object({
    id: z.string(),
    status: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    reasoning: z
      .boolean()
      .nullish()
      .transform((value) => value ?? undefined),
    capabilities: z
      .object({
        reasoning: z
          .boolean()
          .nullish()
          .transform((value) => value ?? undefined),
      })
      .nullish()
      .transform((value) => value ?? undefined),
    variants: z
      .record(z.string(), z.unknown())
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .passthrough();

const ProviderSchema = z
  .object({
    id: z.string(),
    models: z
      .record(z.string(), z.unknown())
      .nullish()
      .transform((models) => {
        if (!models) return undefined;
        return Object.fromEntries(
          Object.entries(models).flatMap(([key, model]) => {
            const parsed = ProviderModelSchema.safeParse(model);
            return parsed.success ? [[key, parsed.data]] : [];
          }),
        );
      }),
  })
  .passthrough();

const ProviderPayloadSchema = z
  .object({
    connected: z
      .array(z.string())
      .nullish()
      .transform((value) => value ?? []),
    all: z
      .array(z.unknown())
      .nullish()
      .transform((providers) =>
        (providers ?? []).flatMap((provider) => {
          const parsed = ProviderSchema.safeParse(provider);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
  })
  .passthrough();

export type ProviderPayload = z.infer<typeof ProviderPayloadSchema>;

const ProviderResponseSchema = z.object({ data: BoundaryValueSchema.optional() }).passthrough();
export type ProviderResponseInput = z.input<typeof ProviderResponseSchema>;

export function parseProviderPayload(response: ProviderResponseInput): ProviderPayload | undefined {
  const parsedResponse = ProviderResponseSchema.safeParse(response);
  if (!parsedResponse.success) return undefined;

  const parsedPayload = ProviderPayloadSchema.safeParse(parsedResponse.data.data);
  return parsedPayload.success ? parsedPayload.data : undefined;
}
