import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexAppServerSpike } from "./spike.js";
import {
  createStagedRepo,
  hashText,
  requireLiveEnvironment,
  reviewInput,
  writeSafeJsonArtifact,
} from "./live-helpers.js";

const enabled = process.env["DIFFOWL_CODEX_APP_SERVER_LIVE"] === "1";
const HUMAN_GATED_TEST_TIMEOUT_MS = 900_000;
const humanGatedTest = (name: string, fn: () => Promise<void>) =>
  it.skipIf(!enabled)(name, fn, HUMAN_GATED_TEST_TIMEOUT_MS);

describe("human-gated Codex App Server live harness", () => {
  humanGatedTest("runs marker and output-schema reviews over equivalent changes", async () => {
    const environment = requireLiveEnvironment();
    const roots = await Promise.all([createStagedRepo("marker"), createStagedRepo("schema")]);
    const records: LiveStrategyRecord[] = [];
    try {
      for (const [root, strategy] of roots.map(
        (root, index) =>
          [
            root,
            index === 0 ? { kind: "marker" as const } : { kind: "output-schema" as const },
          ] as const,
      )) {
        try {
          const outcome = await runCodexAppServerSpike({
            review: reviewInput(root),
            codex: {
              protocol: { executable: environment.codexExecutable },
              appServer: {
                executable: environment.codexExecutable,
                args: ["app-server", "--stdio"],
              },
              model: environment.model,
              strategy,
              artifactDirectory: join(environment.artifactDirectory, strategy.kind),
              timeoutMs: 600_000,
              interruptDeadlineMs: 10_000,
              teardownDeadlineMs: 10_000,
              includeIgnoredRepositoryPaths: true,
            },
          });
          if (outcome.kind === "completed") {
            expect(outcome.codex).toMatchObject({
              authKind: "chatgpt",
              requestedModel: environment.model,
              effectiveModel: expect.any(String),
              apiKeyEnvironmentRemoved: true,
              approvalPolicy: "never",
              sandbox: "read-only",
              networkAccess: false,
              terminalStatus: "completed",
              pidAliveAfterClose: false,
              close: { kind: "eof", code: 0, signal: null },
              repositoryGuard: { kind: "unchanged" },
            });
            expect(outcome.codex.effectiveModel.trim()).not.toBe("");
            expect(outcome.codex.repositoryGuard.beforeSha256).toBe(
              outcome.codex.repositoryGuard.afterTurnSha256,
            );
            expect(outcome.codex.repositoryGuard.beforeSha256).toBe(
              outcome.codex.repositoryGuard.afterCloseSha256,
            );
            expect(outcome.codex.repositoryGuard.includeIgnoredPaths).toBe(true);
            expect(outcome.commandProvenance).toMatchObject({
              configuredExecutablesMatch: true,
              protocol: {
                executableBasename: environment.codexExecutable
                  .replaceAll("\\", "/")
                  .split("/")
                  .at(-1),
                shape: "standard",
                argCount: 0,
              },
              appServer: { shape: "standard", args: ["app-server", "--stdio"] },
              appServerVersion: outcome.protocol.codexCliVersion,
            });
            expect(outcome.artifactPath).toMatch(/\.json$/);
            expect(await readFile(outcome.artifactPath, "utf8")).not.toContain("OPENAI_API_KEY");
            expect(outcome.pipeline.reportPath).toBeTruthy();
            records.push({
              strategy: strategy.kind,
              attempts: outcome.codex.attempts,
              promptSha256: outcome.codex.promptSha256,
              localContextSha256: outcome.codex.localContextSha256,
              developerInstructionsSha256: outcome.codex.developerInstructionsSha256,
              validationAttempts: outcome.codex.validationAttempts,
              summarySha256: hashText(outcome.pipeline.report.summary),
              findings: outcome.pipeline.report.findings.map(safeFinding),
              timings: outcome.codex.timings,
              usage: outcome.pipeline.usage,
              protocol: outcome.protocol,
              process: {
                pid: outcome.codex.pid,
                pidAliveAfterClose: outcome.codex.pidAliveAfterClose,
                close: outcome.codex.close,
              },
              policy: {
                model: outcome.codex.effectiveModel,
                provider: outcome.codex.modelProvider,
                approvalPolicy: outcome.codex.approvalPolicy,
                sandbox: outcome.codex.sandbox,
                networkAccess: outcome.codex.networkAccess,
              },
              repositoryGuard: outcome.codex.repositoryGuard,
            });
          } else {
            records.push({
              strategy: strategy.kind,
              failure: { kind: outcome.kind, message: "strategy did not complete" },
            });
          }
        } catch {
          records.push({
            strategy: strategy.kind,
            failure: { kind: "runner-failed", message: "strategy run failed" },
          });
        }
      }
      expect(records).toHaveLength(2);
      const completed = records.filter(isCompletedLiveStrategy);
      expect(completed).toHaveLength(2);
      expect(completed[0]!.promptSha256).toBe(completed[1]!.promptSha256);
      expect(completed[0]!.localContextSha256).toBe(completed[1]!.localContextSha256);
      expect(completed[0]!.developerInstructionsSha256).not.toBe(
        completed[1]!.developerInstructionsSha256,
      );
    } finally {
      await writeSafeJsonArtifact(join(environment.artifactDirectory, "strategy-comparison"), {
        kind: "codex-strategy-comparison",
        recommendation: "pending-human-review",
        records,
      });
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  humanGatedTest("interrupts an active turn only after output progress", async () => {
    const environment = requireLiveEnvironment();
    const root = await createStagedRepo("cancel");
    const controller = new AbortController();
    try {
      const outcome = await runCodexAppServerSpike({
        review: reviewInput(root),
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === "output") controller.abort();
        },
        codex: {
          protocol: { executable: environment.codexExecutable },
          appServer: {
            executable: environment.codexExecutable,
            args: ["app-server", "--stdio"],
          },
          model: environment.model,
          strategy: { kind: "marker" },
          artifactDirectory: join(environment.artifactDirectory, "cancel"),
          timeoutMs: 600_000,
          interruptDeadlineMs: 10_000,
          teardownDeadlineMs: 10_000,
          includeIgnoredRepositoryPaths: true,
        },
      });
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.artifactPath).toMatch(/\.json$/);
      if (outcome.artifactPath === null) return;
      const artifact: unknown = JSON.parse(await readFile(outcome.artifactPath, "utf8"));
      expect(artifact).toMatchObject({
        failureEvidence: {
          interrupt: {
            deadlineMs: 10_000,
            acknowledgementReceived: true,
            acknowledgementDurationMs: expect.any(Number),
            totalDurationMs: expect.any(Number),
            terminalStatus: "interrupted",
          },
          interruptAcknowledged: true,
          terminalStatus: "interrupted",
          close: { kind: "eof", code: 0, signal: null },
          pid: expect.any(Number),
          pidAliveAfterClose: false,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  humanGatedTest("fails authentication in an isolated CODEX_HOME before a turn", async () => {
    const environment = requireLiveEnvironment();
    const root = await createStagedRepo("unauthenticated");
    const codexHome = await mkdtemp(join(tmpdir(), "diffowl-empty-codex-home-"));
    try {
      const outcome = await runCodexAppServerSpike({
        review: reviewInput(root),
        codex: {
          protocol: {
            executable: environment.codexExecutable,
            env: {
              CODEX_HOME: codexHome,
              OPENAI_API_KEY: "live-test-key",
              CODEX_API_KEY: "live-test-key",
            },
          },
          appServer: {
            executable: environment.codexExecutable,
            args: ["app-server", "--stdio"],
            env: {
              CODEX_HOME: codexHome,
              OPENAI_API_KEY: "live-test-key",
              CODEX_API_KEY: "live-test-key",
            },
          },
          model: environment.model,
          strategy: { kind: "marker" },
          artifactDirectory: join(environment.artifactDirectory, "unauthenticated"),
          timeoutMs: 600_000,
          interruptDeadlineMs: 10_000,
          teardownDeadlineMs: 10_000,
          includeIgnoredRepositoryPaths: true,
        },
      });
      expect(outcome).toMatchObject({ kind: "failed", failure: { kind: "unauthenticated" } });
      if (outcome.kind === "failed") expect(outcome.artifactPath).toBeTruthy();
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(codexHome, { recursive: true, force: true }),
      ]);
    }
  });
});

type LiveStrategyRecord =
  | {
      strategy: "marker" | "output-schema";
      attempts: number;
      promptSha256: string;
      localContextSha256: string;
      developerInstructionsSha256: string;
      validationAttempts: unknown;
      summarySha256: string;
      findings: ReturnType<typeof safeFinding>[];
      timings: readonly { phase: string; ms: number }[];
      usage: unknown;
      protocol: unknown;
      process: unknown;
      policy: unknown;
      repositoryGuard: unknown;
    }
  | { strategy: "marker" | "output-schema"; failure: { kind: string; message: string } };

function safeFinding(finding: {
  file: string;
  line: number;
  severity: string;
  confidence: string;
}) {
  return {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
  };
}

function isCompletedLiveStrategy(
  value: LiveStrategyRecord,
): value is Extract<LiveStrategyRecord, { attempts: number }> {
  return "attempts" in value;
}
