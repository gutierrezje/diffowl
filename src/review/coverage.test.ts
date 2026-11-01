import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DiffOwlConfigSchema } from "../config.js";
import { reviewPolicySha256 } from "./coverage.js";

describe("reviewPolicySha256", () => {
  it("keeps existing coverage valid when focus is unset", () => {
    const config = DiffOwlConfigSchema.parse({ rules: ["Flag hardcoded secrets."] });
    // Version 3 policy identity before review focus existed; existing checkpoints must still match.
    const legacy = createHash("sha256").update(JSON.stringify({
      version: 3,
      depth: "default",
      include: config.include,
      exclude: config.exclude,
      rules: config.rules,
      minConfidence: config.min_confidence,
      skipDocOnly: config.skip_doc_only,
    })).digest("hex");

    expect(reviewPolicySha256(config, "default")).toBe(legacy);
  });

  it("changes with review focus and its order", () => {
    const none = reviewPolicySha256(DiffOwlConfigSchema.parse({}), "default");
    const securityFirst = reviewPolicySha256(DiffOwlConfigSchema.parse({ focus: ["security", "performance"] }), "default");
    const performanceFirst = reviewPolicySha256(DiffOwlConfigSchema.parse({ focus: ["performance", "security"] }), "default");

    expect(securityFirst).not.toBe(none);
    expect(securityFirst).not.toBe(performanceFirst);
  });

  it("changes with path-scoped rules", () => {
    const plain = reviewPolicySha256(DiffOwlConfigSchema.parse({ rules: ["Check ARIA labels."] }), "default");
    const scoped = reviewPolicySha256(DiffOwlConfigSchema.parse({
      rules: [{ paths: ["src/components/**"], rules: ["Check ARIA labels."] }],
    }), "default");

    expect(scoped).not.toBe(plain);
  });
});
