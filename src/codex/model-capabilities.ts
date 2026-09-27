import { performance } from "node:perf_hooks";
import { ReviewCancelledError } from "../review/errors.js";
import { formatReasoningVariantGuidance } from "../review/reasoning.js";
import { findCodexModel, formatMissingCodexModelWarning, type ModelListParams } from "./model-availability.js";
import { CodexTimeoutError, codexProtocolError } from "./errors.js";
import { isRecord, isText, type CodexJsonObject, type CodexJsonValue } from "./types.js";

export type CodexModelResolution = {
  variant: string | undefined;
  warning?: string;
};

export type ResolveCodexModelInput = {
  model: string;
  variant: string | undefined;
  deadline: number;
  events: string[];
  signal?: AbortSignal;
  requestModelList: (
    params: ModelListParams,
    deadline: number,
    signal?: AbortSignal,
  ) => Promise<CodexJsonValue | undefined>;
};

const REASONING_VARIANT_VALIDATION_TIMEOUT_MS = 1_000;

export async function resolveCodexModelCapabilities(
  input: ResolveCodexModelInput,
): Promise<CodexModelResolution> {
  const validationDeadline = Math.min(
    input.deadline,
    performance.now() + REASONING_VARIANT_VALIDATION_TIMEOUT_MS,
  );
  try {
    const model = await loadCodexModel(input, validationDeadline);
    if (model === null) {
      return {
        variant: input.variant,
        warning: formatMissingCodexModelWarning(input.model),
      };
    }
    if (input.variant === undefined) return { variant: undefined };
    const supportedVariants = parseSupportedReasoningEfforts(model);
    if (supportedVariants.includes(input.variant)) {
      return { variant: input.variant };
    }
    return {
      variant: undefined,
      warning: `Codex model "${input.model}" does not advertise reasoning variant "${input.variant}"; continuing with backend default. ${formatReasoningVariantGuidance(supportedVariants)}`,
    };
  } catch (error) {
    if (error instanceof ReviewCancelledError) throw error;
    if (
      error instanceof CodexTimeoutError &&
      (validationDeadline === input.deadline || performance.now() >= input.deadline)
    ) {
      throw error;
    }
    if (input.variant === undefined) return { variant: undefined };
    return {
      variant: input.variant,
      warning: `Codex model "${input.model}" reasoning variant validation was unavailable; forwarding requested variant "${input.variant}" unchanged. If Codex rejects it, remove the one-review \`--reasoning\` override or run \`diffowl reasoning --reset\` to clear the saved preference.`,
    };
  }
}

async function loadCodexModel(
  input: ResolveCodexModelInput,
  deadline: number,
): Promise<CodexJsonObject | null> {
  return findCodexModel(input.model, async (params) => {
    input.events.push("sent:model/list");
    const response = await input.requestModelList(params, deadline, input.signal);
    input.events.push("received:model/list");
    return response;
  });
}

function parseSupportedReasoningEfforts(model: CodexJsonObject): string[] {
  const rawVariants = model["supportedReasoningEfforts"];
  if (!Array.isArray(rawVariants)) {
    throw codexProtocolError("model/list.supportedReasoningEfforts");
  }
  return rawVariants.flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      throw codexProtocolError(`model/list.supportedReasoningEfforts[${index}] must be an object`);
    }
    const effort = candidate["reasoningEffort"];
    if (!isText(effort)) {
      throw codexProtocolError(
        `model/list.supportedReasoningEfforts[${index}].reasoningEffort`,
      );
    }
    return effort === "" ? [] : [effort];
  });
}
