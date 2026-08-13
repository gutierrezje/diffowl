import { describe, expect, it } from "vitest";
import { decideGateExit, resolveGateEnabled } from "./gate.js";
import type { ReviewJsonStatus } from "../output/json.js";

const exitCases: Array<{
  status: ReviewJsonStatus;
  enabled: boolean;
  hook: boolean;
  expected: 0 | 1;
}> = [
  { status: "open", enabled: false, hook: false, expected: 0 },
  { status: "open", enabled: false, hook: true, expected: 0 },
  { status: "open", enabled: true, hook: false, expected: 1 },
  { status: "open", enabled: true, hook: true, expected: 0 },
  { status: "advisory", enabled: false, hook: false, expected: 0 },
  { status: "advisory", enabled: false, hook: true, expected: 0 },
  { status: "advisory", enabled: true, hook: false, expected: 0 },
  { status: "advisory", enabled: true, hook: true, expected: 0 },
  { status: "resolved", enabled: false, hook: false, expected: 0 },
  { status: "resolved", enabled: false, hook: true, expected: 0 },
  { status: "resolved", enabled: true, hook: false, expected: 0 },
  { status: "resolved", enabled: true, hook: true, expected: 0 },
  { status: "skipped", enabled: false, hook: false, expected: 0 },
  { status: "skipped", enabled: false, hook: true, expected: 0 },
  { status: "skipped", enabled: true, hook: false, expected: 0 },
  { status: "skipped", enabled: true, hook: true, expected: 0 },
];

describe("resolveGateEnabled", () => {
  it.each([
    { cliFlag: false, configEnabled: false, expected: false },
    { cliFlag: false, configEnabled: true, expected: true },
    { cliFlag: true, configEnabled: false, expected: true },
    { cliFlag: true, configEnabled: true, expected: true },
  ])(
    "returns $expected for CLI=$cliFlag and config=$configEnabled",
    ({ cliFlag, configEnabled, expected }) => {
      expect(resolveGateEnabled(cliFlag, configEnabled)).toBe(expected);
    },
  );
});

describe("decideGateExit", () => {
  it.each(exitCases)(
    "returns $expected for status=$status enabled=$enabled hook=$hook",
    ({ status, enabled, hook, expected }) => {
      expect(decideGateExit(status, enabled, hook)).toBe(expected);
    },
  );
});
