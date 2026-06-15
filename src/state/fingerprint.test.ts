import { describe, expect, it } from "vitest";
import { computeFindingFingerprint } from "./fingerprint.js";

describe("computeFindingFingerprint", () => {
  const base = {
    file: "src/auth.ts",
    title: "Missing null check",
    body: "The handler does not validate the payload.",
    evidence: "if (!payload) return;",
  };

  it("returns a versioned fingerprint", () => {
    const fingerprint = computeFindingFingerprint(base);
    expect(fingerprint).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it("ignores line numbers because they are not part of identity", () => {
    expect(computeFindingFingerprint(base)).toBe(computeFindingFingerprint(base));
  });

  it("stays stable across whitespace and casing changes", () => {
    const spaced = computeFindingFingerprint({
      ...base,
      file: "  src/auth.ts  ",
      title: "  Missing   Null   Check ",
      evidence: "  if (!payload)   return;  ",
    });
    const compact = computeFindingFingerprint({
      ...base,
      file: "src/auth.ts",
      title: "missing null check",
      evidence: "if (!payload) return;",
    });

    expect(spaced).toBe(compact);
  });

  it("uses body when evidence is absent", () => {
    const withBody = computeFindingFingerprint({
      file: "src/auth.ts",
      title: "Missing null check",
      body: "The handler does not validate the payload.",
    });
    const withEquivalentEvidence = computeFindingFingerprint({
      file: "src/auth.ts",
      title: "Missing null check",
      body: "Different body text",
      evidence: "The handler does not validate the payload.",
    });

    expect(withBody).toBe(withEquivalentEvidence);
  });

  it("creates a separate fingerprint when title or evidence changes", () => {
    const original = computeFindingFingerprint(base);
    const newTitle = computeFindingFingerprint({ ...base, title: "Different title" });
    const newEvidence = computeFindingFingerprint({ ...base, evidence: "return null;" });

    expect(newTitle).not.toBe(original);
    expect(newEvidence).not.toBe(original);
  });
});
