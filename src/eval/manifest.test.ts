import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DiffOwlConfig } from "../config.js";
import { loadEvalCase, loadEvalCorpus } from "./corpus.js";
import { buildEvalManifest } from "./manifest.js";

const corpusDir = join(import.meta.dirname, "../../eval/corpus");

const baseConfig: DiffOwlConfig = {
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  retention: { hook_log_kb: 1024, failed_execution_days: 14, failed_execution_limit: 200 },
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
    const caseDirectory = join(corpusDir, "missing-validation");
    const evalCase = await loadEvalCase(caseDirectory);
    const caseJsonHash = createHash("sha256")
      .update(await readFile(join(caseDirectory, "case.json")))
      .digest("hex");
    const patchHash = createHash("sha256")
      .update(await readFile(join(caseDirectory, "change.patch")))
      .digest("hex");

    const input = {
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
    } satisfies Parameters<typeof buildEvalManifest>[0];
    const manifest = await buildEvalManifest(input);
    const explicitBackendDefaultVariant = await buildEvalManifest({
      ...input,
      options: { ...input.options, reasoning: "backend-default" },
    });

    expect(manifest.corpus_version).toBe(corpus.version);
    expect(manifest.cases).toEqual([{
      id: "missing-validation",
      case_json_hash: caseJsonHash,
      patch_hash: patchHash,
    }]);
    expect(manifest.model).toBe("override/model");
    expect(manifest.reasoning).toBeNull();
    expect(explicitBackendDefaultVariant.reasoning).toBe("backend-default");
    expect(manifest.min_confidence).toBe("high");
    expect(manifest.trials).toBe(3);
    expect(manifest.mode).toBe("both");
    expect(manifest.diffowl_version).toBe("0.3.1");
    expect(manifest.opencode_version).toBe("1.2.3");
  });
});
