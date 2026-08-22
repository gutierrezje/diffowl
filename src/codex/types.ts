import type { JsonValue } from "../review/document.js";

export type CodexJsonValue = JsonValue;
export type CodexJsonObject = { readonly [key: string]: CodexJsonValue };
export type CodexJsonPayload = CodexJsonValue | undefined;
export type CodexEnvelope = { readonly [key: string]: CodexJsonPayload };
export type ErrorDetails = {
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly stderr?: unknown;
  readonly timedOut?: unknown;
};

export type ThrownValue =
  | CodexJsonValue
  | object
  | bigint
  | symbol
  | undefined
  | ((...args: never[]) => void);

export function isRecord(cause: unknown): cause is CodexJsonObject {
  return isJsonObject(cause);
}

export function isObjectValue(cause: unknown): cause is object {
  return typeof cause === "object" && cause !== null;
}

export function isText(cause: unknown): cause is string {
  return typeof cause === "string";
}

export function isBoolean(cause: unknown): cause is boolean {
  return typeof cause === "boolean";
}

export function isFiniteNumber(cause: unknown): cause is number {
  return typeof cause === "number" && Number.isFinite(cause);
}

export function isErrorDetails(cause: unknown): cause is ErrorDetails {
  return isObjectValue(cause) && !Array.isArray(cause);
}

function isJsonValue(cause: unknown): cause is CodexJsonValue {
  if (cause === null) return true;
  if (Array.isArray(cause)) return cause.every(isJsonValue);
  if (isText(cause) || isBoolean(cause) || isFiniteNumber(cause)) return true;
  return isJsonObject(cause);
}

function isJsonObject(cause: unknown): cause is CodexJsonObject {
  if (!isObjectValue(cause) || Array.isArray(cause)) return false;
  const prototype = Object.getPrototypeOf(cause);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(cause).every(isJsonValue)
  );
}

export function isThrownValue(cause: unknown): cause is ThrownValue {
  if (cause === null || cause === undefined) return true;
  switch (typeof cause) {
    case "bigint":
    case "boolean":
    case "function":
    case "number":
    case "object":
    case "string":
    case "symbol":
      return true;
    default:
      return false;
  }
}

export function ensureThrownValue(cause: unknown): ThrownValue {
  if (isThrownValue(cause)) return cause;
  throw new Error("Value is not a JavaScript runtime value.");
}
