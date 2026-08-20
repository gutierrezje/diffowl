import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { DiffOwlConfig } from "../../config.js";
import { commandProvenanceFor, runCodexAppServerSpike } from "./spike.js";

const codexFixture = fileURLToPath(new URL("../../codex/fixtures/mock-codex-cli.mjs", import.meta.url));
const serverFixture = fileURLToPath(new URL("../../codex/fixtures/mock-app-server.mjs", import.meta.url));
const expectedNodeExecutableBasename = basename(process.execPath);
const SLOW_INTEGRATION_TEST_TIMEOUT_MS = 40_000;
const config: DiffOwlConfig = {
  model: "legacy/requested-model",
  server: { port: 4096, auto_start: false },
  context: { depth: "default" },
  reasoning: { effort: "auto" },
  retention: { hook_log_kb: 1024 },
  gate: { fail_on_findings: false },
  timeout: 30,
  min_confidence: "medium",
  include: ["**/*"],
  exclude: [],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

async function makeRepo(empty = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-spike-"));
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execa("git", ["config", "user.name", "DiffOwl Test"], { cwd: root });
  if (!empty) {
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    await execa("git", ["add", "src.ts"], { cwd: root });
    await execa("git", ["commit", "-qm", "baseline"], { cwd: root });
    await writeFile(join(root, "src.ts"), "export const value = 2;\n");
    await execa("git", ["add", "src.ts"], { cwd: root });
  }
  return root;
}

function input(
  root: string,
  artifactDirectory: string,
  appExecutable = process.execPath,
  protocolEnv?: NodeJS.ProcessEnv,
  appMode = "spike-marker",
) {
  return {
    review: {
      target: { kind: "staged" as const },
      config,
      depth: "default" as const,
      verbose: true,
      projectRoot: root,
      diffOwlDir: join(root, ".diffowl"),
      timings: [],
      persistEmptyDiff: false,
    },
    codex: {
      protocol: {
        executable: process.execPath,
        prefixArgs: [codexFixture],
        ...(protocolEnv === undefined ? {} : { env: protocolEnv }),
      },
      appServer: {
        executable: appExecutable,
        args: [serverFixture],
        env: { MOCK_APP_SERVER_MODE: appMode, MOCK_APP_SERVER_MODEL: "gpt-5-codex" },
      },
      model: "gpt-5-codex",
      artifactDirectory,
      timeoutMs: 15_000,
      interruptDeadlineMs: 2_000,
      teardownDeadlineMs: 2_000,
      includeIgnoredRepositoryPaths: true,
    },
  };
}

describe("runCodexAppServerSpike", () => {
  it("redacts command provenance and only exposes standard command shapes", () => {
    const standard = commandProvenanceFor(
      {
        ...input("/tmp/repo", "/tmp/artifacts").codex,
        protocol: { executable: process.execPath },
        appServer: { executable: process.execPath, args: ["app-server", "--stdio"] },
      },
      {
        codexCliVersion: "codex-cli 0.147.0",
        generatedWithoutExperimentalApi: true,
        typesSha256: "a",
        jsonSchemaSha256: "b",
        typesFileCount: 642,
        jsonSchemaFileCount: 285,
      },
    );
    expect(standard).toMatchObject({
      configuredExecutablesMatch: true,
      protocol: {
        executableBasename: expectedNodeExecutableBasename,
        shape: "standard",
        argCount: 0,
      },
      appServer: {
        executableBasename: expectedNodeExecutableBasename,
        shape: "standard",
        args: ["app-server", "--stdio"],
        argCount: 2,
      },
      appServerVersion: "codex-cli 0.147.0",
    });
    const custom = commandProvenanceFor(
      {
        ...input("/tmp/repo", "/tmp/artifacts").codex,
        protocol: { executable: "/secret/custom-codex", prefixArgs: ["--unsafe", "token"] },
        appServer: { executable: "/other/custom", args: ["--stdio", "secret"] },
      },
      null,
    );
    expect(JSON.stringify(custom)).not.toContain("/secret");
    expect(JSON.stringify(custom)).not.toContain("token");
    expect(custom).toMatchObject({
      configuredExecutablesMatch: false,
      protocol: { executableBasename: "custom-codex", shape: "custom", argCount: 2 },
      appServer: { executableBasename: "custom", shape: "custom", args: null, argCount: 2 },
    });
  });

  it("runs the real review pipeline and writes redacted evidence", async () => {
    const root = await makeRepo();
    try {
      const statuses: string[] = [];
      const outcome = await runCodexAppServerSpike({
        ...input(root, join(root, "artifacts")),
        onStatus: (status) => statuses.push(status),
      });
      expect(outcome.kind, JSON.stringify(outcome)).toBe("completed");
      if (outcome.kind !== "completed") return;
      expect(outcome.pipeline.reportPath).toBeTruthy();
      expect(outcome.pipeline.sessionId).toBe("thread-1");
      expect(outcome.pipeline.suppressed).toEqual({ outsideChangedFiles: 1, belowConfidence: 1 });
      expect(outcome.codex?.threadId).toBe("thread-1");
      expect(outcome.codex?.pid).toBeTypeOf("number");
      expect(outcome.codex?.pidAliveAfterClose).toBe(false);
      expect(outcome.codex?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.codex?.localContextSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.codex?.events).toContain("sent:initialize");
      expect(outcome.codex?.events).toContain("received:turn/completed:completed");
      expect(outcome.codex?.validationAttempts).toMatchObject([
        { turnId: "turn-1", outcome: "accepted" },
      ]);
      expect(statuses).toEqual(["Reviewing changes..."]);
      expect(outcome.pipeline.timings).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "review-run", label: "Codex review run" }),
      ]));
      expect(outcome.pipeline.timings.some((timing) => timing.label.includes("OpenCode"))).toBe(false);
      expect(outcome.protocol.typesFileCount).toBe(642);
      expect(outcome.artifactPath).toBeTruthy();
      const artifact = await readFile(outcome.artifactPath!, "utf8");
      expect(artifact).toContain('"legacyPersistence"');
      expect(artifact).toContain('"requestedConfigModel":"legacy/requested-model"');
      expect(artifact).not.toContain('"findings"');
      expect(artifact).not.toContain("In-scope finding");
      expect(artifact).not.toContain("A useful finding.");
      expect(artifact).not.toContain("OPENAI_API_KEY");
      expect(artifact).not.toContain("test@example.invalid");
      expect(await stat(outcome.pipeline.reportPath!)).toBeTruthy();
      expect(await stat(join(root, ".diffowl", "state.db"))).toBeTruthy();
      if (process.platform !== "win32") {
        expect((await stat(join(root, "artifacts"))).mode & 0o777).toBe(0o700);
        expect((await stat(outcome.artifactPath!)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_INTEGRATION_TEST_TIMEOUT_MS);

  it("writes a cancellation artifact before the disposable repository is removed", async () => {
    const root = await makeRepo();
    const controller = new AbortController();
    try {
      const outcome = await runCodexAppServerSpike({
        ...input(root, join(root, "artifacts"), process.execPath, undefined, "spike-cancel-active"),
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === "output") controller.abort();
        },
      });
      expect(outcome).toMatchObject({ kind: "failed", failure: { kind: "cancelled" } });
      if (outcome.kind !== "failed") return;
      expect(outcome.artifactPath).toMatch(/\.json$/);
      if (outcome.artifactPath === null) return;
      const artifact: unknown = JSON.parse(await readFile(outcome.artifactPath, "utf8"));
      expect(artifact).toMatchObject({
        failureEvidence: {
          interrupt: {
            deadlineMs: 2_000,
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
          repositoryBeforeSha256: expect.any(String),
          repositoryAfterTurnSha256: expect.any(String),
          repositoryAfterCloseSha256: expect.any(String),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_INTEGRATION_TEST_TIMEOUT_MS);

  it("inspects protocol before an empty pipeline without spawning App Server", async () => {
    const root = await makeRepo(true);
    try {
      const outcome = await runCodexAppServerSpike(
        input(root, join(root, "artifacts"), "/missing/app-server"),
      );
      expect(outcome.kind).toBe("not-run");
      if (outcome.kind !== "not-run") return;
      expect(outcome.protocol.codexCliVersion).toBe("codex-cli 0.147.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes protocol failures and reports artifact-write failures", async () => {
    const root = await makeRepo(true);
    try {
      const failed = await runCodexAppServerSpike(
        input(root, join(root, "artifacts"), process.execPath, {
          MOCK_CLI_MODE: "invalid-version",
        }),
      );
      expect(failed.kind).toBe("failed");
      if (failed.kind !== "failed") return;
      expect(failed.failure.kind).toBe("protocol-incompatible");
      expect(failed.artifactPath).toBeTruthy();

      const artifactFile = join(root, "artifact-file");
      await writeFile(artifactFile, "not a directory");
      const artifactFailure = await runCodexAppServerSpike(input(root, artifactFile));
      expect(artifactFailure).toMatchObject({
        kind: "failed",
        artifactPath: null,
        failure: { kind: "artifact-write-failed" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes exhausted schema validation without raw output", async () => {
    const root = await makeRepo();
    try {
      const outcome = await runCodexAppServerSpike(
        input(root, join(root, "artifacts"), process.execPath, undefined, "spike-three-invalid"),
      );
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        kind: "failed",
        failure: { kind: "validation-exhausted" },
        failureEvidence: {
          requestedModel: "gpt-5-codex",
          threadId: "thread-1",
          turnIds: ["turn-1", "turn-2", "turn-3"],
          validationAttempts: [
            { turnId: "turn-1", outcome: "retry" },
            { turnId: "turn-2", outcome: "retry" },
            { turnId: "turn-3", outcome: "failed" },
          ],
        },
      });
      if (outcome.kind !== "failed" || outcome.artifactPath === null) return;
      const artifact = await readFile(outcome.artifactPath, "utf8");
      expect(artifact).not.toContain("not-an-array");
      expect(artifact).toContain('"failureEvidence"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing App Server executable", "/missing/app-server", "spike-marker", "executable-missing"],
    ["unexpected server request", process.execPath, "server-request", "policy-violation"],
  ])("serializes %s", async (_label, executable, mode, failureKind) => {
    const root = await makeRepo();
    try {
      const outcome = await runCodexAppServerSpike(
        input(root, join(root, "artifacts"), executable, undefined, mode),
      );
      expect(outcome).toMatchObject({ kind: "failed", failure: { kind: failureKind } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
