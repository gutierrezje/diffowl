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

export type EvalSchemaInput = EvalJsonValue | object;

export function parseEvalJson(text: string): EvalJsonValue {
  return JSON.parse(text);
}
