import { z } from "zod";

export const ReasoningVariantSchema = z
  .string()
  .trim()
  .min(1, "Reasoning variant must not be empty");

export type ReasoningVariant = z.output<typeof ReasoningVariantSchema>;
export type ReasoningSelection =
  | { kind: "backend-default" }
  | { kind: "variant"; value: ReasoningVariant };

export const BACKEND_DEFAULT_REASONING: ReasoningSelection = { kind: "backend-default" };

export function parseReasoningVariant(value: string): ReasoningVariant {
  return ReasoningVariantSchema.parse(value);
}

export function selectReasoningVariant(value: string): ReasoningSelection {
  return { kind: "variant", value: parseReasoningVariant(value) };
}

export function reasoningVariant(selection: ReasoningSelection): ReasoningVariant | undefined {
  switch (selection.kind) {
    case "backend-default":
      return undefined;
    case "variant":
      return selection.value;
    default: {
      const exhaustive: never = selection;
      return exhaustive;
    }
  }
}

export function formatReasoningSelection(selection: ReasoningSelection): string {
  return reasoningVariant(selection) ?? "backend-default";
}
