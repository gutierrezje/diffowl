import { describe, expect, it } from "vitest";
import { getReviewBackendFailureGuidance } from "./guidance.js";

describe("getReviewBackendFailureGuidance", () => {
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

  it("preserves the existing OpenCode guidance", () => {
    expect(getReviewBackendFailureGuidance("opencode", "ECONNREFUSED")).toContain(
      "Start the managed server: diffowl server start",
    );
  });

  it.each([
    {
      message: "Cursor ACP executable was not found.",
      expected: ["Cursor runtime is not installed", "ensure `cursor-agent` is on PATH"],
    },
    {
      message: "Cursor authentication failed.",
      expected: ["Cursor authentication is missing", "Run `cursor-agent login`"],
    },
    {
      message: 'Cursor does not advertise model "missing".',
      expected: ["Cursor rejected the selected model", "Run `diffowl model --list`"],
    },
    {
      message: "Invalid Cursor ACP payload: initialize.protocolVersion.",
      expected: ["Cursor runtime is incompatible", "Update the Cursor CLI"],
    },
  ])("names Cursor and gives a deterministic action for $message", ({ message, expected }) => {
    const guidance = getReviewBackendFailureGuidance("cursor", message).join("\n");

    for (const fragment of expected) expect(guidance).toContain(fragment);
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
