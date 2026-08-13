import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import { loadEvalCase, loadEvalCorpus } from "./corpus.js";
import { buildEvalManifest } from "./manifest.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

const baseConfig: DiffOwlConfig = {
  model: "provider/model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 300,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

describe("buildEvalManifest", () => {
  it("captures corpus hashes, config, and tool versions", async () => {
    const corpus = await loadEvalCorpus(corpusDir);
    const evalCase = await loadEvalCase(join(corpusDir, "missing-validation"));

    const manifest = await buildEvalManifest({
      corpus,
      cases: [evalCase],
      config: baseConfig,
      options: { model: "override/model", trials: 3, minConfidence: "high" },
      mode: "both",
      trials: 3,
      startedAt: "2026-06-29T00:00:00.000Z",
      finishedAt: "2026-06-29T00:05:00.000Z",
      versions: {
        diffowlVersion: "0.3.1",
        nodeVersion: "v22.14.0",
        opencodeVersion: "1.2.3",
      },
    });

    expect(manifest.corpus_version).toBe(corpus.version);
    expect(manifest.cases).toHaveLength(1);
    expect(manifest.cases[0]?.id).toBe("missing-validation");
    expect(manifest.model).toBe("override/model");
    expect(manifest.min_confidence).toBe("high");
    expect(manifest.trials).toBe(3);
    expect(manifest.mode).toBe("both");
    expect(manifest.diffowl_version).toBe("0.3.1");
    expect(manifest.opencode_version).toBe("1.2.3");
  });
});
