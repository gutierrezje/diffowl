import { z } from "zod";

const ProviderModelSchema = z
  .object({
    id: z.string(),
    status: z.string().nullish().transform((value) => value ?? undefined),
    reasoning: z.boolean().nullish().transform((value) => value ?? undefined),
    capabilities: z
      .object({
        reasoning: z.boolean().nullish().transform((value) => value ?? undefined),
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
    connected: z.array(z.string()).nullish().transform((value) => value ?? []),
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

export function parseProviderPayload(response: unknown): ProviderPayload | undefined {
  if (!response || typeof response !== "object") return undefined;
  return ProviderPayloadSchema.safeParse((response as { data?: unknown }).data).data;
}
