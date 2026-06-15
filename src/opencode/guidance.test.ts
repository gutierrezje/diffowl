import { describe, expect, it } from "vitest";

import { getOpenCodeFailureGuidance } from "./guidance.js";

describe("getOpenCodeFailureGuidance", () => {
  it("explains how to install a missing OpenCode CLI", () => {
    expect(getOpenCodeFailureGuidance("opencode not found")).toEqual([
      "Install OpenCode: npm install --global opencode-ai",
      "Run `opencode`, connect a provider, then retry the DiffOwl command.",
      "Docs: https://opencode.ai/docs/",
    ]);
  });

  it("explains how to recover from authentication and provider failures", () => {
    expect(
      getOpenCodeFailureGuidance("OpenCode request failed (phase=request, cause=401 Unauthorized)"),
    ).toEqual([
      "Run `opencode` and connect or re-authenticate a provider.",
      "Confirm a model is available, then retry the DiffOwl command.",
    ]);
  });

  it("explains how to recover when the OpenCode server is unavailable", () => {
    expect(
      getOpenCodeFailureGuidance(
        "OpenCode request failed (phase=request, cause=connect ECONNREFUSED)",
      ),
    ).toEqual([
      "Start the managed server: diffowl server start",
      "Then retry the DiffOwl command.",
    ]);
  });

  it("suggests a shallow retry after a timeout", () => {
    expect(getOpenCodeFailureGuidance("Review timed out after 300s")).toEqual([
      "Retry with less context: diffowl review --depth shallow",
    ]);
  });

  it("explains how to recover from native module ABI mismatch", () => {
    expect(
      getOpenCodeFailureGuidance(
        "NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 127",
      ),
    ).toEqual([
      "Native module ABI mismatch. Rebuild for your active Node: pnpm rebuild better-sqlite3",
      "Reinstall the hook so it uses the same Node as the CLI: diffowl hook install",
      "Compare the required NODE_MODULE_VERSION with the Hook Node ABI from `diffowl hook install`.",
    ]);
  });

  it("explains how to recover from OpenCode server version skew", () => {
    expect(
      getOpenCodeFailureGuidance(
        "OpenCode session failed: SQLiteError: NOT NULL constraint failed: session_message.seq",
      ),
    ).toEqual([
      "OpenCode server version may be stale. Check: diffowl server status",
      "Restart the server: diffowl server stop && diffowl server start",
      "Confirm server and CLI versions match: opencode --version",
    ]);
  });

  it("explains how to recover from provider quota or rate limit errors", () => {
    const expected = [
      "Provider quota or rate limit reached. Wait a few minutes and retry.",
      "If persistent, check your provider dashboard for usage limits and billing.",
      "You can also try a different model: diffowl review --model <model>",
    ];

    expect(
      getOpenCodeFailureGuidance("Provider quota or rate limit reached: 429 Too Many Requests"),
    ).toEqual(expected);

    expect(
      getOpenCodeFailureGuidance("Provider quota or rate limit reached: insufficient_quota"),
    ).toEqual(expected);

    expect(
      getOpenCodeFailureGuidance("Provider quota or rate limit reached: overloaded_error"),
    ).toEqual(expected);

    expect(
      getOpenCodeFailureGuidance("Provider quota or rate limit reached: RESOURCE_EXHAUSTED"),
    ).toEqual(expected);
  });

  it("does not guess at unrelated failures", () => {
    expect(getOpenCodeFailureGuidance("Unexpected formatter failure")).toEqual([]);
  });
});
