import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePosixProcessIdentity,
  parseWindowsListenerPids,
  parseUnixListenerPids,
} from "./live-helpers.js";

afterEach(() => vi.unstubAllEnvs());

describe("live harness provenance helpers", () => {
  it("parses one Unix listener PID from lsof output", () => {
    expect(parseUnixListenerPids("1234\n1234\n")).toEqual([1234]);
  });

  it("parses only listening Windows endpoints for the configured port", () => {
    expect(
      parseWindowsListenerPids(
        "  TCP    0.0.0.0:4096       0.0.0.0:0       LISTENING       4321\r\n" +
          "  TCP    0.0.0.0:40960      0.0.0.0:0       LISTENING       9876\r\n" +
          "  TCP    127.0.0.1:4096     127.0.0.1:1     ESTABLISHED     1111\r\n",
        4096,
      ),
    ).toEqual([4321]);
  });

  it("sanitizes a serving command into basename and digest", () => {
    expect(parsePosixProcessIdentity("/opt/bin/opencode serve --port 4096")).toEqual({
      executableBasename: "opencode",
      commandSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
