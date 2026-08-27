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

export function formatReasoningVariantGuidance(variants: Iterable<string>): string {
  const advertised = [...variants];
  if (advertised.length === 0) {
    return "This model advertises no selectable reasoning variants. Remove the one-review `--reasoning` override or run `diffowl reasoning --reset` to clear the saved preference.";
  }
  return `Advertised variants: ${advertised
    .map((candidate) => JSON.stringify(candidate))
    .join(", ")}. Use one of those values, remove the one-review \`--reasoning\` override, or run \`diffowl reasoning --reset\` to clear the saved preference.`;
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
