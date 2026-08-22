import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexAppServerSpike } from "./spike.js";
import { createStagedRepo, requireLiveEnvironment, reviewInput } from "./live-helpers.js";

const enabled = process.env["DIFFOWL_CODEX_APP_SERVER_LIVE"] === "1";
const CODEX_PHASE_TIMEOUT_MS = 600_000;
const HUMAN_GATED_TEST_TIMEOUT_MS = CODEX_PHASE_TIMEOUT_MS * 2 + 120_000;
const humanGatedTest = (name: string, fn: () => Promise<void>) =>
  it.skipIf(!enabled)(name, fn, HUMAN_GATED_TEST_TIMEOUT_MS);

describe("human-gated Codex App Server live harness", () => {
  humanGatedTest("completes one guarded native-schema review", async () => {
    const environment = requireLiveEnvironment();
    const root = await createStagedRepo("native-schema");
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
          artifactDirectory: join(environment.artifactDirectory, "native-schema"),
          timeoutMs: CODEX_PHASE_TIMEOUT_MS,
          interruptDeadlineMs: 10_000,
          teardownDeadlineMs: 10_000,
          includeIgnoredRepositoryPaths: true,
        },
      });

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") return;
      expect(outcome.codex).toMatchObject({
        authKind: "chatgpt",
        requestedModel: environment.model,
        effectiveModel: expect.any(String),
        documentMode: "native-json",
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
          executableBasename: environment.codexExecutable.replaceAll("\\", "/").split("/").at(-1),
          ["shape"]: "standard",
          argCount: 0,
        },
        appServer: { ["shape"]: "standard", args: ["app-server", "--stdio"] },
        appServerVersion: outcome.protocol.codexCliVersion,
      });
      expect(outcome.artifactPath).toMatch(/\.json$/);
      expect(await readFile(outcome.artifactPath, "utf8")).not.toContain("OPENAI_API_KEY");
      expect(outcome.pipeline.reportPath).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
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
          artifactDirectory: join(environment.artifactDirectory, "cancel"),
          timeoutMs: CODEX_PHASE_TIMEOUT_MS,
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
          artifactDirectory: join(environment.artifactDirectory, "unauthenticated"),
          timeoutMs: CODEX_PHASE_TIMEOUT_MS,
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
