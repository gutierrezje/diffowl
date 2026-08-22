import { z } from "zod";

export interface EvalJsonObject {
  readonly [key: string]: EvalJsonValue;
}

export type EvalJsonValue =
  | null
  | boolean
  | number
  | string
  | EvalJsonValue[]
  | EvalJsonObject;

export const EvalJsonValueSchema: z.ZodType<EvalJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(EvalJsonValueSchema),
    z.record(z.string(), EvalJsonValueSchema),
  ]),
);

export function parseEvalJson(text: string): EvalJsonValue {
  return EvalJsonValueSchema.parse(JSON.parse(text));
}
