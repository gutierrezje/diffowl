import { describe, expect, it } from "vitest";
import { getReviewBackendFailureGuidance } from "./guidance.js";

describe("getReviewBackendFailureGuidance", () => {
  it("directs Cursor SDK authentication failures to its own login", () => {
    const guidance = getReviewBackendFailureGuidance("cursor", "Missing API key").join("\n");
    expect(guidance).toContain("diffowl cursor login");
    expect(guidance).toContain("Cursor CLI login is separate");
    expect(guidance).not.toContain("Codex");
  });

  it.each([
    {
      message: "Codex CLI executable was not found.",
      expected: ["Codex runtime is not installed", "ensure `codex` is on PATH"],
    },
    {
      message: "Codex account is not authenticated.",
      expected: ["Codex authentication is missing", "sign in with ChatGPT"],
    },
    {
      message: "Codex protocol is incompatible: missing turn/start.",
      expected: ["Codex runtime is incompatible", "Update the Codex CLI"],
    },
    {
      message: "Unsupported model gpt-missing.",
      expected: ["Codex rejected the selected model", "diffowl model <model-id>"],
    },
  ])("names Codex and gives a deterministic action for $message", ({ message, expected }) => {
    const guidance = getReviewBackendFailureGuidance("codex", message).join("\n");

    for (const fragment of expected) expect(guidance).toContain(fragment);
  });

  it.each([
    {
      message: "Claude CLI executable was not found (ENOENT).",
      expected: ["Claude Code CLI is not installed", "ensure `claude` is on PATH"],
    },
    {
      message: "Claude authentication is missing.",
      expected: ["Claude Code authentication is missing", "`claude auth login`"],
    },
    {
      message: "Login expired",
      expected: ["Claude Code authentication is missing", "`claude auth login`"],
    },
    {
      message:
        "Login expired · Run /login to sign in again, or re-authenticate your Anthropic profile",
      expected: ["Claude Code authentication is missing", "`claude auth login`"],
    },
    {
      message: "Unknown model sonnet-next.",
      expected: ["Claude rejected the selected model", "diffowl model <model-id>"],
    },
  ])("gives Claude Code recovery steps for $message", ({ message, expected }) => {
    const guidance = getReviewBackendFailureGuidance("claude", message).join("\n");

    for (const fragment of expected) expect(guidance).toContain(fragment);
    expect(guidance.toLowerCase()).not.toMatch(/subscription|entitlement|billing/);
  });

  it("preserves the existing OpenCode guidance", () => {
    expect(getReviewBackendFailureGuidance("opencode", "ECONNREFUSED")).toContain(
      "Start the managed server: diffowl server start",
    );
  });

  it("classifies a Codex RPC model rejection without echoing provider data", () => {
    const guidance = getReviewBackendFailureGuidance("codex", {
      message: "App Server request failed.",
      rpcError: { code: -32000, message: "Unknown model", data: { account: "private" } },
    }).join("\n");

    expect(guidance).toContain("Codex rejected the selected model");
    expect(guidance).not.toContain("private");
  });
});
