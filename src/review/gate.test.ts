import { describe, expect, it } from "vitest";
import { decideGateExit, resolveCompletedReviewExit, resolveGateEnabled } from "./gate.js";
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

const completedExitCases: Array<{
  status: ReviewJsonStatus;
  cliFlag: boolean;
  configEnabled: boolean;
  hook: boolean;
  jsonMode: boolean;
  exitCode: 0 | 1;
  announceFailure: boolean;
}> = [
  {
    status: "open",
    cliFlag: true,
    configEnabled: false,
    hook: false,
    jsonMode: false,
    exitCode: 1,
    announceFailure: true,
  },
  {
    status: "open",
    cliFlag: true,
    configEnabled: false,
    hook: false,
    jsonMode: true,
    exitCode: 1,
    announceFailure: false,
  },
  {
    status: "open",
    cliFlag: false,
    configEnabled: true,
    hook: false,
    jsonMode: false,
    exitCode: 1,
    announceFailure: true,
  },
  {
    status: "open",
    cliFlag: true,
    configEnabled: true,
    hook: true,
    jsonMode: false,
    exitCode: 0,
    announceFailure: false,
  },
  {
    status: "open",
    cliFlag: false,
    configEnabled: false,
    hook: false,
    jsonMode: false,
    exitCode: 0,
    announceFailure: false,
  },
  {
    status: "advisory",
    cliFlag: true,
    configEnabled: true,
    hook: false,
    jsonMode: false,
    exitCode: 0,
    announceFailure: false,
  },
];

describe("resolveCompletedReviewExit", () => {
  it.each(completedExitCases)(
    "returns exitCode=$exitCode announceFailure=$announceFailure for status=$status cli=$cliFlag config=$configEnabled hook=$hook json=$jsonMode",
    (input) => {
      expect(
        resolveCompletedReviewExit({
          status: input.status,
          cliFlag: input.cliFlag,
          configEnabled: input.configEnabled,
          hook: input.hook,
          jsonMode: input.jsonMode,
        }),
      ).toEqual({ exitCode: input.exitCode, announceFailure: input.announceFailure });
    },
  );
});
