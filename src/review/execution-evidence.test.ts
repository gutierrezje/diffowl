import {
  createReviewPipelineEvidence,
  createUnknownReviewRuntimeEvidence,
  mergeReviewRuntimeEvidence,
} from "./execution-evidence.js";
import { computeReviewContextManifestSha256, type ReviewContextManifest } from "./operation.js";
import { describe, expect, it } from "vitest";
import { config } from "./run.test-support.js";

describe("review execution evidence", () => {
  it("merges facts without erasing observed values with later unknowns", () => {
    const known = mergeReviewRuntimeEvidence(createUnknownReviewRuntimeEvidence(), {
      ...createUnknownReviewRuntimeEvidence(),
      provider: "openai",
      effectiveModel: "gpt-5.6",
      native: {
        ...createUnknownReviewRuntimeEvidence().native,
        threadId: "thread-1",
        turnIds: ["turn-1", "turn-2"],
      },
    });
    const merged = mergeReviewRuntimeEvidence(known, createUnknownReviewRuntimeEvidence());
    expect(merged.provider).toBe("openai");
    expect(merged.effectiveModel).toBe("gpt-5.6");
    expect(merged.native.threadId).toBe("thread-1");
    expect(merged.native.turnIds).toEqual(["turn-1", "turn-2"]);
  });

  it("hashes policy inputs independently and matches the operation context identity", () => {
    const context: ReviewContextManifest = {
      schemaVersion: 1,
      depth: "default",
      renderedContextSha256: "a".repeat(64),
      changedFileCount: 2,
      skippedFileCount: 1,
      relatedFileCount: 3,
      referenceCount: 4,
      degradationCounts: [{ code: "typescript-ast-unavailable", count: 1 }],
    };
    const first = createReviewPipelineEvidence({ config, contextManifest: context });
    const second = createReviewPipelineEvidence({
      config: { ...config, rules: ["Require tests"] },
      contextManifest: context,
    });
    expect(first.contextManifestSha256).toBe(computeReviewContextManifestSha256(context));
    expect(first.context).toEqual({
      changedFileCount: 2,
      skippedFileCount: 1,
      relatedFileCount: 3,
      referenceCount: 4,
      degradationCounts: { "typescript-ast-unavailable": 1 },
    });
    expect(first.rulesSha256).not.toBe(second.rulesSha256);
    expect(first.configSha256).not.toBe(second.configSha256);
    expect(first.profileSha256).toBe(second.profileSha256);
    const shallowOverride = createReviewPipelineEvidence({
      config,
      contextManifest: { ...context, depth: "shallow" },
    });
    expect(shallowOverride.configSha256).not.toBe(first.configSha256);
    expect(shallowOverride.profileSha256).not.toBe(first.profileSha256);
  });

  it("keeps observational settings out of comparison identity", () => {
    const baseline = createReviewPipelineEvidence({ config, contextManifest: null });
    const observed = createReviewPipelineEvidence({
      config: {
        ...config,
        server: { port: 65501, auto_start: false },
        retention: { hook_log_kb: 20, failed_execution_days: 1, failed_execution_limit: 2 },
        verbose: !config.verbose,
      },
      contextManifest: null,
    });
    expect(observed).toEqual(baseline);
    const changedProfile = createReviewPipelineEvidence({
      config: { ...config, context: { depth: "shallow" } },
      contextManifest: null,
    });
    expect(changedProfile.configSha256).not.toBe(baseline.configSha256);
    expect(changedProfile.profileSha256).not.toBe(baseline.profileSha256);
    expect(changedProfile.schemaSha256).toBe(baseline.schemaSha256);
  });
});
