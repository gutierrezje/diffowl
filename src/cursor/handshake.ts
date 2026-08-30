import packageJson from "../../package.json" with { type: "json" };
import { ReviewCancelledError } from "../review/errors.js";
import type { AcpPayload } from "./acp-peer.js";
import { CursorReviewError, CursorTimeoutError, cursorProtocolError } from "./errors.js";
import {
  isCursorBoolean,
  isCursorJsonObject,
  isCursorText,
  type CursorJsonObject,
  type CursorJsonValue,
} from "./types.js";

export type CursorRequest = (
  method: string,
  params: CursorJsonValue,
  phase: string,
) => Promise<AcpPayload>;

export type CursorConfigOption = {
  id: string;
  category: string;
  currentValue: string | boolean;
  values: readonly string[];
};

export type CursorSessionSetup = {
  sessionId: string;
  modes: readonly string[];
  configOptions: readonly CursorConfigOption[];
};

export type CursorDiscoveredModel = {
  id: string;
  name: string;
};

export async function initializeCursorConnection(request: CursorRequest): Promise<void> {
  const initialized = asRecord(
    await request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
        clientInfo: { name: "diffowl", version: packageJson.version },
      },
      "initialize",
    ),
    "initialize",
  );
  validateInitialization(initialized);
  try {
    await request("authenticate", { methodId: "cursor_login" }, "authenticate");
  } catch (cause) {
    if (cause instanceof ReviewCancelledError || cause instanceof CursorTimeoutError) throw cause;
    throw new CursorReviewError(
      "authentication",
      `Cursor authentication failed. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function createCursorSession(
  request: CursorRequest,
  directory: string,
): Promise<CursorSessionSetup> {
  return parseSessionSetup(
    await request("session/new", { cwd: directory, mcpServers: [] }, "session/new"),
  );
}

export function parseCursorConfigOptions(cause: unknown): CursorConfigOption[] {
  if (!Array.isArray(cause)) throw cursorProtocolError("configOptions");
  return cause.map((entry, index) => {
    const option = asRecord(entry, `configOptions[${index}]`);
    const type = requiredString(option, "type", `configOptions[${index}].type`);
    const currentValue = option["currentValue"];
    if (!isCursorText(currentValue) && !isCursorBoolean(currentValue)) {
      throw cursorProtocolError(`configOptions[${index}].currentValue`);
    }
    return {
      id: requiredString(option, "id", `configOptions[${index}].id`),
      category: requiredString(option, "category", `configOptions[${index}].category`),
      currentValue,
      values: type === "select" ? parseSelectValues(option["options"]) : [],
    };
  });
}

export function requireCursorConfigOption(
  options: readonly CursorConfigOption[],
  id: string,
  category: string,
): CursorConfigOption {
  const option = options.find((candidate) => candidate.id === id || candidate.category === category);
  if (option === undefined) throw cursorProtocolError(`missing ${category} config option`);
  return option;
}

export function parseCursorDiscoveredModels(value: AcpPayload): CursorDiscoveredModel[] {
  const response = asRecord(value, "cursor/list_available_models");
  const models = response["models"];
  if (!Array.isArray(models)) throw cursorProtocolError("cursor/list_available_models.models");
  const seen = new Set<string>();
  return models.flatMap((entry, index) => {
    const model = asRecord(entry, `cursor/list_available_models.models[${index}]`);
    const id = requiredString(
      model,
      "value",
      `cursor/list_available_models.models[${index}].value`,
    ).trim();
    const name = requiredString(
      model,
      "name",
      `cursor/list_available_models.models[${index}].name`,
    ).trim();
    if (id === "" || name === "" || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name }];
  });
}

function validateInitialization(value: CursorJsonObject): void {
  if (value["protocolVersion"] !== 1) throw cursorProtocolError("initialize.protocolVersion");
  const methods = value["authMethods"];
  if (
    !Array.isArray(methods) ||
    !methods.some((method) => isCursorJsonObject(method) && method["id"] === "cursor_login")
  ) {
    throw new CursorReviewError(
      "authentication",
      "Cursor ACP did not advertise cursor_login authentication.",
    );
  }
}

function parseSessionSetup(value: AcpPayload): CursorSessionSetup {
  const session = asRecord(value, "session/new");
  const sessionId = requiredString(session, "sessionId", "session/new.sessionId");
  const modesValue = asRecord(session["modes"], "session/new.modes");
  const availableModes = modesValue["availableModes"];
  if (!Array.isArray(availableModes)) throw cursorProtocolError("session/new.modes.availableModes");
  const modes = availableModes.map((mode, index) =>
    requiredString(
      asRecord(mode, `session/new.modes.availableModes[${index}]`),
      "id",
      `session/new.modes.availableModes[${index}].id`,
    ),
  );
  return {
    sessionId,
    modes,
    configOptions: parseCursorConfigOptions(session["configOptions"]),
  };
}

function parseSelectValues(cause: unknown): string[] {
  if (!Array.isArray(cause)) return [];
  return cause.flatMap((entry) => {
    if (!isCursorJsonObject(entry)) return [];
    if (isCursorText(entry["value"])) return [entry["value"]];
    const nested = entry["options"];
    return Array.isArray(nested)
      ? nested.flatMap((option) =>
          isCursorJsonObject(option) && isCursorText(option["value"]) ? [option["value"]] : [],
        )
      : [];
  });
}

function asRecord(cause: unknown, context: string): CursorJsonObject {
  if (!isCursorJsonObject(cause)) throw cursorProtocolError(`${context} must be an object`);
  return cause;
}

function requiredString(value: CursorJsonObject, key: string, context: string): string {
  const result = value[key];
  if (!isCursorText(result) || result === "") {
    throw cursorProtocolError(`${context} must be a non-empty string`);
  }
  return result;
}
