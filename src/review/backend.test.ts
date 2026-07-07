import { afterEach, describe, expect, it } from "vitest";

import { parseReviewBackendName, resolveReviewBackend } from "./backend.js";

const originalEnv = process.env["DIFFOWL_BACKEND"];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env["DIFFOWL_BACKEND"];
  } else {
    process.env["DIFFOWL_BACKEND"] = originalEnv;
  }
});

describe("parseReviewBackendName", () => {
  it("accepts known backends", () => {
    expect(parseReviewBackendName("opencode")).toBe("opencode");
    expect(parseReviewBackendName("pi")).toBe("pi");
  });

  it("rejects unknown backends with the valid options listed", () => {
    expect(() => parseReviewBackendName("codex")).toThrow(/opencode, pi/);
    expect(() => parseReviewBackendName("")).toThrow(/Unknown review backend/);
    expect(() => parseReviewBackendName(undefined)).toThrow(/Unknown review backend/);
  });
});

describe("resolveReviewBackend", () => {
  it("defaults to opencode", () => {
    delete process.env["DIFFOWL_BACKEND"];
    expect(resolveReviewBackend().name).toBe("opencode");
    expect(resolveReviewBackend("").name).toBe("opencode");
  });

  it("prefers the explicit name over the environment", () => {
    process.env["DIFFOWL_BACKEND"] = "pi";
    expect(resolveReviewBackend("opencode").name).toBe("opencode");
  });

  it("falls back to DIFFOWL_BACKEND", () => {
    process.env["DIFFOWL_BACKEND"] = "pi";
    expect(resolveReviewBackend().name).toBe("pi");
  });

  it("fails loudly on invalid selections instead of silently reviewing", () => {
    process.env["DIFFOWL_BACKEND"] = "hermes";
    expect(() => resolveReviewBackend()).toThrow(/Unknown review backend "hermes"/);
    expect(() => resolveReviewBackend("cursor")).toThrow(/Unknown review backend "cursor"/);
  });

  it("exposes prepare, runReview, and version on both backends", () => {
    for (const name of ["opencode", "pi"] as const) {
      const backend = resolveReviewBackend(name);
      expect(backend.name).toBe(name);
      expect(typeof backend.prepare).toBe("function");
      expect(typeof backend.runReview).toBe("function");
      expect(typeof backend.version).toBe("function");
    }
  });

  it("pi prepare is a no-op (no server lifecycle)", async () => {
    const backend = resolveReviewBackend("pi");
    await expect(
      backend.prepare({ server: { port: 1, auto_start: false } } as never),
    ).resolves.toBeUndefined();
  });
});
