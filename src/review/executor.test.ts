import { describe, expect, it, vi } from "vitest";
import type { CodexReviewExecutorOptions } from "../codex/executor.js";
import type { ReviewExecutor } from "./types.js";
import { createSelectedReviewExecutor } from "./executor.js";

const openCodeExecutor: ReviewExecutor = { execute: vi.fn() };
const codexExecutor: ReviewExecutor = { execute: vi.fn() };

describe("createSelectedReviewExecutor", () => {
  it("constructs only the selected OpenCode adapter", () => {
    const createOpenCode = vi.fn(() => openCodeExecutor);
    const createCodex = vi.fn(() => codexExecutor);

    const executor = createSelectedReviewExecutor(
      {
        backend: "opencode",
        requestedModel: "provider/model",
        source: { backend: "default", model: "local" },
      },
      { createOpenCode, createCodex },
    );

    expect(executor).toBe(openCodeExecutor);
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
      {
        backend: "codex",
        requestedModel: "gpt-5.4",
        source: { backend: "command", model: "command" },
      },
      { createOpenCode: () => openCodeExecutor, createCodex },
      { DIFFOWL_CODEX_EXECUTABLE: "/opt/codex" },
    );

    expect(executor).toBe(codexExecutor);
    expect(options).toMatchObject({
      command: { executable: "/opt/codex" },
      model: "gpt-5.4",
    });
  });
});
