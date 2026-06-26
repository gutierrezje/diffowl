import { describe, expect, it } from "vitest";
import { loadEvalCase } from "./corpus.js";
import { runEvalCaseTrial } from "./runner.js";
import { join } from "node:path";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

describe.skipIf(!process.env["DIFFOWL_EVAL_MODEL"]?.trim())("eval runner integration", () => {
  it("reviews a single corpus case against a real model", async () => {
    const evalCase = await loadEvalCase(join(corpusDir, "harmless-trim"));
    const result = await runEvalCaseTrial(evalCase);

    expect(result.error).toBeUndefined();
    expect(result.sessionId).not.toBe("");
    expect(result.summary.trim().length).toBeGreaterThan(0);
  }, 300_000);
});
