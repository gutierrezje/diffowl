import type { JsonValue } from "../review/document.js";

export type CursorJsonValue = JsonValue;
export type CursorJsonObject = { readonly [key: string]: CursorJsonValue };
export type CursorJsonPayload = CursorJsonValue | undefined;

export function isCursorJsonObject(cause: unknown): cause is CursorJsonObject {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) return false;
  const prototype = Object.getPrototypeOf(cause);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(cause).every(isCursorJsonValue)
  );
}

export function isCursorJsonValue(cause: unknown): cause is CursorJsonValue {
  if (cause === null) return true;
  if (Array.isArray(cause)) return cause.every(isCursorJsonValue);
  if (typeof cause === "string" || typeof cause === "boolean") return true;
  if (typeof cause === "number") return Number.isFinite(cause);
  return isCursorJsonObject(cause);
}

export function isCursorText(cause: unknown): cause is string {
  return typeof cause === "string";
}

export function isCursorBoolean(cause: unknown): cause is boolean {
  return typeof cause === "boolean";
}

export function isCursorFiniteNumber(cause: unknown): cause is number {
  return typeof cause === "number" && Number.isFinite(cause);
}
