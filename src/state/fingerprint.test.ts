import { describe, expect, it } from "vitest";
import { computeFindingFingerprint } from "./fingerprint.js";

describe("computeFindingFingerprint", () => {
  const base = {
    file: "src/auth.ts",
    evidence: "if (!payload) return;",
  };

  it("returns a versioned fingerprint", () => {
    const fingerprint = computeFindingFingerprint(base);
    expect(fingerprint).toMatch(/^v2:[a-f0-9]{64}$/);
  });

  it("shares a key for the same file and evidence when titles differ", () => {
    const left = {
      file: "src/auth.ts",
      evidence: "if (!payload) return;",
      title: "Missing null check",
    };
    const right = {
      file: "src/auth.ts",
      evidence: "if (!payload) return;",
      title: "Handler skips payload validation",
    };

    expect(computeFindingFingerprint(left)).toBe(computeFindingFingerprint(right));
  });

  it("creates a separate fingerprint when evidence in the same file changes", () => {
    const original = computeFindingFingerprint(base);
    const other = computeFindingFingerprint({
      file: "src/auth.ts",
      evidence: "return null;",
    });

    expect(other).not.toBe(original);
  });

  it("stays stable across whitespace and casing changes", () => {
    const spaced = computeFindingFingerprint({
      file: "  src/auth.ts  ",
      evidence: "  if (!payload)   return;  ",
    });
    const compact = computeFindingFingerprint({
      file: "src/auth.ts",
      evidence: "if (!payload) return;",
    });

    expect(spaced).toBe(compact);
  });

  it("returns null when evidence is missing or whitespace-only", () => {
    expect(computeFindingFingerprint({ file: "src/auth.ts" })).toBeNull();
    expect(computeFindingFingerprint({ file: "src/auth.ts", evidence: "" })).toBeNull();
    expect(computeFindingFingerprint({ file: "src/auth.ts", evidence: "   \n\t  " })).toBeNull();
    expect(
      computeFindingFingerprint({
        file: "src/auth.ts",
        body: "The handler does not validate the payload.",
      }),
    ).toBeNull();
  });
});
