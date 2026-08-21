import { describe, expect, it, vi } from "vitest";
import type { CodexReviewExecutorOptions } from "../codex/executor.js";
import type { ReviewExecutor } from "./types.js";
import { createSelectedReviewExecutor } from "./executor.js";
import { createSingleReviewAssignment } from "./provenance.js";

const openCodeExecutor: ReviewExecutor = { execute: vi.fn() };
const codexExecutor: ReviewExecutor = { execute: vi.fn() };

describe("createSelectedReviewExecutor", () => {
  it("constructs only the selected OpenCode adapter", () => {
    const createOpenCode = vi.fn(() => openCodeExecutor);
    const createCodex = vi.fn(() => codexExecutor);

    const executor = createSelectedReviewExecutor(
      createSingleReviewAssignment({
        backend: "opencode",
        requestedModel: "provider/model",
        source: { backend: "default", model: "local" },
      }, "auto"),
      { createOpenCode, createCodex },
    );

    expect(executor).not.toBe(openCodeExecutor);
    expect(createOpenCode).toHaveBeenCalledOnce();
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("passes the explicit Codex model and executable to the Codex adapter", () => {
    let options: CodexReviewExecutorOptions | undefined;
    const createCodex = vi.fn((input: CodexReviewExecutorOptions) => {
      options = input;
      return codexExecutor;
    });

    const executor = createSelectedReviewExecutor(
      createSingleReviewAssignment({
        backend: "codex",
        requestedModel: "gpt-5.4",
        source: { backend: "command", model: "command" },
      }, "auto"),
      { createOpenCode: () => openCodeExecutor, createCodex },
      { DIFFOWL_CODEX_EXECUTABLE: "/opt/codex" },
    );

    expect(executor).not.toBe(codexExecutor);
    expect(options).toMatchObject({
      command: { executable: "/opt/codex" },
      model: "gpt-5.4",
    });
  });

  it("returns provider-neutral provenance for the selected reviewer assignment", async () => {
    const adapter = completedExecutor({ effectiveModel: "gpt-5.6-luna-2026-08-20" });
    const assignment = createSingleReviewAssignment(
      {
        backend: "codex",
        requestedModel: "gpt-5.6-luna",
        source: { backend: "local", model: "local" },
      },
      "max",
    );
    const executor = createSelectedReviewExecutor(
      assignment,
      { createOpenCode: () => openCodeExecutor, createCodex: () => adapter },
      {},
    );

    const result = await executor.execute(reviewExecutorOptions("gpt-5.6-luna", "max"));

    expect(result.provenance).toEqual({
      schemaVersion: 1,
      cohortId: null,
      reviewerId: "single",
      role: "single",
      backend: "codex",
      requestedModel: "gpt-5.6-luna",
      effectiveModel: "gpt-5.6-luna-2026-08-20",
      preferenceSource: { backend: "local", model: "local" },
      reasoningEffort: "max",
      sessionId: "review-session",
      terminalOutcome: "completed",
    });
  });

  it("records an unavailable OpenCode effective model as unknown", async () => {
    const adapter = completedExecutor({});
    const executor = createSelectedReviewExecutor(
      createSingleReviewAssignment(
        {
          backend: "opencode",
          requestedModel: "provider/model",
          source: { backend: "default", model: "local" },
        },
        "high",
      ),
      { createOpenCode: () => adapter, createCodex: () => codexExecutor },
    );

    const result = await executor.execute(reviewExecutorOptions("provider/model", "high"));

    expect(result.provenance).toMatchObject({
      backend: "opencode",
      requestedModel: "provider/model",
      effectiveModel: null,
      reviewerId: "single",
      role: "single",
      sessionId: "review-session",
    });
  });
});

function completedExecutor(input: { effectiveModel?: string }): ReviewExecutor {
  return {
    execute: vi.fn(async () => ({
      review: {
        report: { summary: "No findings.", findings: [] },
        sessionId: "review-session",
      },
      timings: [],
      ...(input.effectiveModel === undefined ? {} : { effectiveModel: input.effectiveModel }),
    })),
  };
}

function reviewExecutorOptions(model: string, effort: "high" | "max") {
  return {
    review: {
      target: { kind: "last-commit" } as const,
      directory: "/repo",
      config: {
        model,
        server: { port: 4096, auto_start: false },
        context: { depth: "default" as const },
        reasoning: { effort },
        retention: { hook_log_kb: 1024 },
        gate: { fail_on_findings: false },
        timeout: 300,
        min_confidence: "medium" as const,
        include: ["**/*"],
        exclude: [],
        rules: [],
        skip_doc_only: false,
        verbose: false,
      },
      depth: "default" as const,
    },
  };
}
