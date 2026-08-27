import { performance } from "node:perf_hooks";
import { ReviewCancelledError } from "../review/errors.js";
import { formatReasoningVariantGuidance } from "../review/reasoning.js";
import { CodexTimeoutError, codexProtocolError } from "./errors.js";
import {
  isRecord,
  isText,
  type CodexJsonObject,
  type CodexJsonValue,
} from "./types.js";

export type ReasoningVariantResolution =
  | { kind: "supported"; variant: string }
  | { kind: "unsupported"; warning: string }
  | { kind: "unavailable"; variant: string; warning: string };

type ModelListRequestParameters = {
  includeHidden: true;
  limit: number;
  cursor?: string;
};

export type ResolveReasoningVariantInput = {
  model: string;
  variant: string;
  deadline: number;
  events: string[];
  signal?: AbortSignal;
  requestModelList: (
    params: ModelListRequestParameters,
    deadline: number,
    signal?: AbortSignal,
  ) => Promise<CodexJsonValue | undefined>;
};

type ModelListPage = {
  models: CodexJsonObject[];
  nextCursor: CodexJsonValue | undefined;
};

const REASONING_VARIANT_VALIDATION_TIMEOUT_MS = 1_000;

export async function resolveCodexReasoningVariant(
  input: ResolveReasoningVariantInput,
): Promise<ReasoningVariantResolution> {
  const validationDeadline = Math.min(
    input.deadline,
    performance.now() + REASONING_VARIANT_VALIDATION_TIMEOUT_MS,
  );
  try {
    const supportedVariants = await loadSupportedReasoningEfforts(
      input,
      validationDeadline,
    );
    if (supportedVariants.includes(input.variant)) {
      return { kind: "supported", variant: input.variant };
    }
    return {
      kind: "unsupported",
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
    return {
      kind: "unavailable",
      variant: input.variant,
      warning: `Codex model "${input.model}" reasoning variant validation was unavailable; forwarding requested variant "${input.variant}" unchanged. If Codex rejects it, remove the one-review \`--reasoning\` override or run \`diffowl reasoning --reset\` to clear the saved preference.`,
    };
  }
}

async function loadSupportedReasoningEfforts(
  input: ResolveReasoningVariantInput,
  deadline: number,
): Promise<string[]> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const params =
      cursor === undefined
        ? { includeHidden: true as const, limit: 100 }
        : { includeHidden: true as const, limit: 100, cursor };
    input.events.push("sent:model/list");
    const response = await input.requestModelList(params, deadline, input.signal);
    input.events.push("received:model/list");
    const page = parseModelListPage(response);
    const selected = page.models.find((candidate) => modelListEntryMatches(candidate, input.model));
    if (selected !== undefined) return parseSupportedReasoningEfforts(selected);
    const nextCursor = parseModelListNextCursor(page.nextCursor);
    if (nextCursor === null) {
      throw codexProtocolError(`model/list missing model ${input.model}`);
    }
    if (seenCursors.has(nextCursor)) {
      throw codexProtocolError("model/list repeated nextCursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function parseModelListPage(value: CodexJsonValue | undefined): ModelListPage {
  if (!isRecord(value)) throw codexProtocolError("model/list must be an object");
  const models = value["data"];
  if (!Array.isArray(models)) throw codexProtocolError("model/list.data");
  return { models: models.filter(isRecord), nextCursor: value["nextCursor"] };
}

function parseModelListNextCursor(value: CodexJsonValue | undefined): string | null {
  if (value === null) return null;
  if (!isText(value) || value === "") throw codexProtocolError("model/list.nextCursor");
  return value;
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

function modelListEntryMatches(value: CodexJsonObject, model: string): boolean {
  return value["id"] === model || value["model"] === model;
}
