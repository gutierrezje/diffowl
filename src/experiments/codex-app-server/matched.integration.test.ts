import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReviewPrompts } from "../../opencode/client.js";
import { defaultReviewPipelineDeps, runReviewPipeline } from "../../review/run.js";
import { scoreEvalTrial } from "../../eval/score.js";
import { hashCase, loadEvalCase } from "../../eval/corpus.js";
import { withMaterializedEvalCase } from "../../eval/repo.js";
import { collectEvalCaseExpected, type EvalCase } from "../../eval/case-types.js";
import type { ReviewFinding } from "../../review/types.js";
import type { ReviewUsage } from "../../review/usage.js";
import type { AppServerCloseResult } from "./app-server-peer.js";
import { runCodexAppServerSpike } from "./spike.js";
import type { OpenCodeProvenance } from "./live-helpers.js";
import {
  assertStableOpenCodeProvenance,
  captureOpenCodeProvenance,
  hashText,
  liveConfig,
  requireCodexStrategy,
  reviewInput,
  writeSafeJsonArtifact,
} from "./live-helpers.js";

const enabled = process.env["DIFFOWL_CODEX_MATCHED_LIVE"] === "1";

describe("human-gated Codex/OpenCode matched harness", () => {
  it.skipIf(!enabled)(
    "runs directional seeded-positive and clean cases with matched hashes",
    async () => {
      const codexModel = process.env["DIFFOWL_CODEX_MODEL"]?.trim() ?? "";
      const opencodeModel = process.env["DIFFOWL_OPENCODE_MODEL"]?.trim() ?? "";
      const artifactDirectory = process.env["DIFFOWL_CODEX_ARTIFACT_DIR"]?.trim() ?? "";
      const codexStrategy = requireCodexStrategy();
      if (
        codexModel === "" ||
        codexModel.includes("/") ||
        !opencodeModel.includes("/") ||
        artifactDirectory === ""
      ) {
        throw new Error(
          "Matched live mode requires bare DIFFOWL_CODEX_MODEL, provider/model DIFFOWL_OPENCODE_MODEL, and DIFFOWL_CODEX_ARTIFACT_DIR.",
        );
      }
      const corpusDirectory = join(process.cwd(), "eval", "corpus");
      const cases = await Promise.all([
        loadEvalCase(join(corpusDirectory, "off-by-one-slice")),
        loadEvalCase(join(corpusDirectory, "harmless-trim")),
      ]);
      const records: MatchedRecord[] = [];
      let failure: unknown;
      try {
        for (const evalCase of cases) {
          records.push(
            await runMatchedCase(
              evalCase,
              codexModel,
              opencodeModel,
              codexStrategy,
              artifactDirectory,
            ),
          );
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const artifactPath = await writeSafeJsonArtifact(artifactDirectory, {
          kind: "matched-codex-opencode",
          codexStrategy: codexStrategy.kind,
          commandShapes: {
            codex: [
              (process.env["DIFFOWL_CODEX_EXECUTABLE"] ?? "codex")
                .replaceAll("\\", "/")
                .split("/")
                .at(-1) ?? "codex",
              "app-server",
              "--stdio",
            ],
            opencode: "normal OpenCode review pipeline",
          },
          codexCliVersion:
            records.find((record) => record.codex.protocol)?.codex.protocol.codexCliVersion ??
            "unavailable",
          cases: records,
          failure:
            failure === undefined
              ? null
              : { kind: "comparison-failed", message: "Matched live comparison failed." },
        });
        expect(artifactPath).toMatch(/\.json$/);
      }
    },
  );
});

type MatchedRecord = {
  caseId: string;
  target: string;
  caseJsonHash: string;
  patchHash: string;
  durationMs: { codex: number; opencode: number };
  config: { depth: string; rules: { count: number; sha256: string } };
  codex: {
    strategy: "marker" | "output-schema";
    executableBasename: string;
    args: readonly ["app-server", "--stdio"];
    protocol: {
      codexCliVersion: string;
      typesSha256: string;
      jsonSchemaSha256: string;
      typesFileCount: number;
      jsonSchemaFileCount: number;
    };
    evidence: {
      threadId: string;
      requestedModel: string;
      effectiveModel: string;
      modelProvider: string;
      approvalPolicy: "never";
      sandbox: "read-only";
      networkAccess: false;
      repositoryGuard: {
        kind: "unchanged";
        includeIgnoredPaths: boolean;
        beforeSha256: string;
        afterTurnSha256: string;
        afterCloseSha256: string;
      };
      promptSha256: string;
      localContextSha256: string;
      usagePresent: boolean;
      usage: ReviewUsage | null;
      pid: number;
      pidAliveAfterClose: false;
      close: AppServerCloseResult;
      events: readonly string[];
      timings: readonly { phase: string; ms: number }[];
      validationAttempts: unknown;
    };
    pipelineTimings: readonly { phase: string; ms: number }[];
    score: ScoreSummary;
  };
  opencode: {
    model: string;
    provenance: { before: OpenCodeProvenance; after: OpenCodeProvenance };
    sessionId: string;
    promptSha256: string;
    localContextSha256: string;
    usage: ReviewUsage | null;
    timings: readonly { phase: string; ms: number }[];
    score: ScoreSummary;
  };
};

type ScoreSummary = {
  tp: number;
  fp: number;
  fn: number;
  findings: readonly FindingSummary[];
  matches: readonly { expected: Coordinate; reported: Coordinate }[];
  falsePositives: readonly Coordinate[];
  falseNegatives: readonly Coordinate[];
};
type FindingSummary = Pick<ReviewFinding, "file" | "line" | "severity" | "confidence">;
type Coordinate = { file: string; line: number; severity?: string; confidence?: string };

async function runMatchedCase(
  evalCase: EvalCase,
  codexModel: string,
  opencodeModel: string,
  codexStrategy: ReturnType<typeof requireCodexStrategy>,
  artifactDirectory: string,
): Promise<MatchedRecord> {
  return withMaterializedEvalCase(evalCase, async (codexRepo) =>
    withMaterializedEvalCase(evalCase, async (opencodeRepo) => {
      const hashes = await hashCase(evalCase.dir);
      const config = { ...liveConfig, model: opencodeModel };
      const codexStarted = performance.now();
      const codex = await runCodexAppServerSpike({
        review: reviewInput(codexRepo.workDir, codexRepo.target, config),
        codex: {
          protocol: { executable: process.env["DIFFOWL_CODEX_EXECUTABLE"] ?? "codex" },
          appServer: {
            executable: process.env["DIFFOWL_CODEX_EXECUTABLE"] ?? "codex",
            args: ["app-server", "--stdio"],
          },
          model: codexModel,
          strategy: codexStrategy,
          artifactDirectory: join(artifactDirectory, evalCase.id, "codex"),
          timeoutMs: 600_000,
          interruptDeadlineMs: 10_000,
          teardownDeadlineMs: 10_000,
          includeIgnoredRepositoryPaths: true,
        },
      });
      const codexDurationMs = performance.now() - codexStarted;
      if (codex.kind !== "completed")
        throw new Error(`Codex case ${evalCase.id} did not complete.`);

      let opencodePromptSha256 = "";
      let opencodeContextSha256 = "";
      let opencodeBefore: OpenCodeProvenance | undefined;
      const opencodeStarted = performance.now();
      const outcome = await runReviewPipeline(
        reviewInput(opencodeRepo.workDir, opencodeRepo.target, config),
        {
          ...defaultReviewPipelineDeps,
          ensureServer: async (port) => {
            const baseUrl = await defaultReviewPipelineDeps.ensureServer(port);
            opencodeBefore = await captureOpenCodeProvenance(port, baseUrl);
            return baseUrl;
          },
          runReview: async (options) => {
            const prompts = resolveReviewPrompts({
              target: options.target,
              config: options.config,
              depth: options.depth,
              ...(options.localContext === undefined ? {} : { localContext: options.localContext }),
            });
            opencodePromptSha256 = hashText(prompts.user);
            opencodeContextSha256 = hashText(options.localContext ?? "");
            return defaultReviewPipelineDeps.runReview(options);
          },
        },
      );
      const opencodeDurationMs = performance.now() - opencodeStarted;
      if (outcome.kind !== "completed")
        throw new Error(`OpenCode case ${evalCase.id} did not complete.`);
      if (opencodeBefore === undefined) {
        throw new Error(`OpenCode case ${evalCase.id} did not capture pre-review provenance.`);
      }
      const opencodeAfter = await captureOpenCodeProvenance(
        config.server.port,
        opencodeBefore.baseUrl,
      );
      assertStableOpenCodeProvenance(opencodeBefore, opencodeAfter);
      expect(codex.codex.promptSha256).toBe(opencodePromptSha256);
      expect(codex.codex.localContextSha256).toBe(opencodeContextSha256);
      return {
        caseId: evalCase.id,
        target: evalCase.target,
        caseJsonHash: hashes.caseJsonHash,
        patchHash: hashes.patchHash,
        durationMs: { codex: codexDurationMs, opencode: opencodeDurationMs },
        config: {
          depth: config.context.depth,
          rules: { count: config.rules.length, sha256: hashText(JSON.stringify(config.rules)) },
        },
        codex: {
          strategy: codex.codex.strategy.kind,
          executableBasename: codex.commandProvenance.appServer.executableBasename,
          args: ["app-server", "--stdio"],
          protocol: {
            codexCliVersion: codex.protocol.codexCliVersion,
            typesSha256: codex.protocol.typesSha256,
            jsonSchemaSha256: codex.protocol.jsonSchemaSha256,
            typesFileCount: codex.protocol.typesFileCount,
            jsonSchemaFileCount: codex.protocol.jsonSchemaFileCount,
          },
          evidence: {
            threadId: codex.codex.threadId,
            requestedModel: codex.codex.requestedModel,
            effectiveModel: codex.codex.effectiveModel,
            modelProvider: codex.codex.modelProvider,
            approvalPolicy: codex.codex.approvalPolicy,
            sandbox: codex.codex.sandbox,
            networkAccess: codex.codex.networkAccess,
            repositoryGuard: codex.codex.repositoryGuard,
            promptSha256: codex.codex.promptSha256,
            localContextSha256: codex.codex.localContextSha256,
            usagePresent: codex.codex.usagePresent,
            usage: codex.pipeline.usage,
            pid: codex.codex.pid,
            pidAliveAfterClose: codex.codex.pidAliveAfterClose,
            close: codex.codex.close,
            events: codex.codex.events,
            timings: codex.codex.timings,
            validationAttempts: codex.codex.validationAttempts,
          },
          pipelineTimings: codex.pipeline.timings,
          score: summarizeScore(
            scoreCase(evalCase, codex.pipeline.report.findings, "diffowl"),
            evalCase,
            codex.pipeline.report.findings,
          ),
        },
        opencode: {
          model: opencodeModel,
          provenance: { before: opencodeBefore, after: opencodeAfter },
          sessionId: outcome.sessionId,
          promptSha256: opencodePromptSha256,
          localContextSha256: opencodeContextSha256,
          usage: outcome.usage,
          timings: outcome.timings,
          score: summarizeScore(
            scoreCase(evalCase, outcome.report.findings, "baseline"),
            evalCase,
            outcome.report.findings,
          ),
        },
      };
    }),
  );
}

function scoreCase(evalCase: EvalCase, findings: ReviewFinding[], mode: "diffowl" | "baseline") {
  return scoreEvalTrial(evalCase, {
    caseId: evalCase.id,
    trial: 0,
    mode,
    findings,
    timings: [],
    sessionId: "live",
    summary: "",
    diagnostics: [],
    durationMs: 0,
  });
}

function summarizeScore(
  score: ReturnType<typeof scoreCase>,
  evalCase: EvalCase,
  findings: readonly ReviewFinding[],
): ScoreSummary {
  const expected = collectEvalCaseExpected(evalCase);
  const coordinate = (finding: ReviewFinding): Coordinate => ({
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
  });
  return {
    ...score.counts,
    findings: findings.map((finding) => ({
      file: finding.file,
      line: finding.line,
      severity: finding.severity,
      confidence: finding.confidence,
    })),
    matches: score.truePositives.flatMap((match) => {
      const expectedFinding = expected[match.expectedIndex];
      const reportedFinding = findings[match.reportedIndex];
      return expectedFinding === undefined || reportedFinding === undefined
        ? []
        : [
            {
              expected: { file: expectedFinding.file, line: expectedFinding.line },
              reported: coordinate(reportedFinding),
            },
          ];
    }),
    falsePositives: score.falsePositives.map(coordinate),
    falseNegatives: score.falseNegatives.map((finding) => ({
      file: finding.file,
      line: finding.line,
      severity: finding.min_severity,
    })),
  };
}
