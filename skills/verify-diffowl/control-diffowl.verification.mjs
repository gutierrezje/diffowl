import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { resolveOwnedArtifact } from "./controller/provider-state.mjs";

const projectRoot = join(import.meta.dirname, "../..");
const controller = join(import.meta.dirname, "control-diffowl");

describe("control-diffowl", () => {
  it("exposes a small discoverable interface with surface-specific capabilities", async () => {
    await access(controller);

    const help = await execa(controller, ["--help"], { cwd: projectRoot });
    expect(help.stdout).toContain("control-diffowl run <surface> <feature-id>");
    expect(help.stdout).toContain("cli | codex | opencode");
    expect(help.stdout).toContain("Recovery:");

    const leafHelp = await execa(controller, ["cli", "doctor", "--help"], {
      cwd: projectRoot,
    });
    expect(leafHelp.stdout).toContain("Prerequisites:");
    expect(leafHelp.stdout).toContain("Side effects:");
    expect(leafHelp.stdout).toContain("Output:");

    const capabilities = await execa(controller, ["codex", "capabilities", "--json"], {
      cwd: projectRoot,
    });
    expect(JSON.parse(capabilities.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "capabilities",
      success: true,
      surface: "codex",
      features: expect.arrayContaining(["codex-runtime-ready", "codex-review-staged"]),
      commands: expect.arrayContaining([
        "doctor",
        "new-run",
        "info",
        "receipt",
        "snapshot",
        "console",
        "network-summary",
        "wait-settle",
        "cancel",
        "cleanup",
      ]),
    });
  });

  it("keeps dry-run creation side-effect free and rejects artifacts outside the scratch", async () => {
    const runId = `controller-dry-run-${process.pid}-${Date.now()}`;
    const preview = JSON.parse(
      (
        await execa(
          controller,
          ["cli", "new-run", "cli-version-help", "--run-id", runId, "--dry-run", "--json"],
          { cwd: projectRoot },
        )
      ).stdout,
    );
    expect(preview).toMatchObject({
      command: "new-run",
      success: true,
      dryRun: true,
      runId,
      planned: { featureId: "cli-version-help" },
    });
    expect(
      existsSync(join(projectRoot, "artifacts", "verification", "runs", `${runId}.json`)),
    ).toBe(false);

    const scratch = await mkdtemp(join(tmpdir(), "control-diffowl-owned-"));
    const outside = await mkdtemp(join(tmpdir(), "control-diffowl-outside-"));
    try {
      const owned = join(scratch, "report.md");
      const unowned = join(outside, "report.md");
      await Promise.all([writeFile(owned, "owned\n"), writeFile(unowned, "unowned\n")]);
      expect(await resolveOwnedArtifact(scratch, owned)).not.toBeNull();
      expect(await resolveOwnedArtifact(scratch, unowned)).toBeNull();
    } finally {
      await Promise.all([
        rm(scratch, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("creates an owned run with an inspectable receipt and dry-run cleanup", async () => {
    const runId = `controller-test-${process.pid}-${Date.now()}`;
    const created = await execa(
      controller,
      ["cli", "new-run", "cli-version-help", "--run-id", runId],
      { cwd: projectRoot },
    );
    const scratch = created.stdout;

    expect(created.stderr).toBe("");
    expect(existsSync(scratch)).toBe(true);

    try {
      const info = JSON.parse(
        (
          await execa(controller, ["cli", "info", "--run", runId, "--json"], {
            cwd: projectRoot,
          })
        ).stdout,
      );
      expect(info).toMatchObject({
        schemaVersion: 1,
        command: "info",
        success: true,
        surface: "cli",
        runId,
        observedTarget: { scratch },
      });

      const doctor = JSON.parse(
        (
          await execa(controller, ["cli", "doctor", "--run", runId, "--json"], {
            cwd: projectRoot,
          })
        ).stdout,
      );
      expect(doctor).toMatchObject({
        schemaVersion: 1,
        command: "doctor",
        success: true,
        identity: {
          source: { head: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: true },
          binary: {
            version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
            hash: expect.stringMatching(/^[0-9a-f]{40}$/),
          },
          scratch: { path: scratch },
          runtime: {
            requestedBackend: null,
            effectiveBackend: null,
            requestedModel: null,
            effectiveModel: null,
            authentication: "not-required",
            server: { pid: null, port: expect.any(Number) },
            sessionId: null,
            turnId: null,
            children: [],
          },
        },
      });

      const snapshot = JSON.parse(
        (
          await execa(
            controller,
            ["cli", "snapshot", "--run", runId, "--label", "before", "--json"],
            { cwd: projectRoot },
          )
        ).stdout,
      );
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        command: "snapshot",
        success: true,
        state: {
          git: { head: expect.stringMatching(/^[0-9a-f]{40}$/) },
          database: { present: false },
          processes: [],
          reviews: [],
        },
      });

      const receipt = JSON.parse(
        (
          await execa(controller, ["cli", "receipt", "--run", runId, "--json"], {
            cwd: projectRoot,
          })
        ).stdout,
      );
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        result: "INCONCLUSIVE",
        feature: { id: "cli-version-help", entryPoint: "diffowl -V; diffowl --help" },
        target: {
          source: expect.any(String),
          artifact: expect.any(String),
          runtime: expect.any(String),
        },
        actions: [
          {
            command: "snapshot",
            label: "before",
            at: expect.any(String),
          },
        ],
        observed: [],
        artifacts: expect.arrayContaining([expect.stringContaining(runId)]),
        mutation: { authority: "disposable-repository-only", records: [] },
        cleanup: { removed: [], restored: [], retained: expect.any(Array), running: [] },
      });

      const dryRun = JSON.parse(
        (
          await execa(controller, ["cli", "cleanup", "--run", runId, "--dry-run", "--json"], {
            cwd: projectRoot,
          })
        ).stdout,
      );
      expect(dryRun).toMatchObject({
        command: "cleanup",
        success: true,
        dryRun: true,
        cleanup: { removed: [], retained: expect.arrayContaining([scratch]) },
      });
      expect(existsSync(scratch)).toBe(true);
    } finally {
      await execa(controller, ["cli", "cleanup", "--run", runId, "--json"], {
        cwd: projectRoot,
      });
    }

    expect(existsSync(scratch)).toBe(false);
  }, 30_000);

  it("runs an offline CLI feature and verifies behavior, Git immutability, and teardown in one receipt", async () => {
    const runId = `controller-run-test-${process.pid}-${Date.now()}`;
    const executed = JSON.parse(
      (
        await execa(controller, ["run", "cli", "cli-version-help", "--run-id", runId, "--json"], {
          cwd: projectRoot,
        })
      ).stdout,
    );

    expect(executed).toMatchObject({
      schemaVersion: 1,
      command: "run",
      success: true,
      surface: "cli",
      runId,
      result: "VERIFIED",
      receipt: expect.stringContaining("receipt.json"),
      verification: {
        behavior: true,
        report: "not-required",
        database: "not-required",
        repositoryImmutable: true,
        teardown: true,
      },
    });

    try {
      const receipt = JSON.parse(await readReceipt(executed.receipt));
      expect(receipt).toMatchObject({
        result: "VERIFIED",
        feature: { id: "cli-version-help" },
        target: {
          source: expect.any(String),
          artifact: expect.stringContaining("version"),
          runtime: expect.stringContaining('"surface":"cli"'),
        },
        actions: expect.arrayContaining([
          expect.objectContaining({ command: "snapshot", label: "before" }),
          expect.objectContaining({ command: "diffowl -V" }),
          expect.objectContaining({ command: "diffowl --help" }),
          expect.objectContaining({ command: "snapshot", label: "after" }),
        ]),
        observed: expect.arrayContaining([
          expect.objectContaining({ check: "version matches package", ok: true }),
          expect.objectContaining({ check: "repository immutable", ok: true }),
        ]),
        cleanup: { running: [] },
        confounds: [],
      });

      const before = JSON.parse(
        await readReceipt(join(executed.evidence, "snapshots", "before.json")),
      );
      const after = JSON.parse(
        await readReceipt(join(executed.evidence, "snapshots", "after.json")),
      );
      expect(after.state.git).toEqual(before.state.git);
    } finally {
      await execa(controller, ["cli", "cleanup", "--run", runId, "--json"], {
        cwd: projectRoot,
      });
    }
  }, 30_000);

  it("exposes JSON Lines console output and bounded lifecycle inspection for one owned run", async () => {
    const runId = `controller-observe-test-${process.pid}-${Date.now()}`;
    const executed = JSON.parse(
      (
        await execa(controller, ["run", "cli", "cli-version-help", "--run-id", runId, "--json"], {
          cwd: projectRoot,
        })
      ).stdout,
    );

    try {
      const consoleOutput = await execa(controller, ["cli", "console", "--run", runId], {
        cwd: projectRoot,
      });
      const events = consoleOutput.stdout.split("\n").map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaVersion: 1,
            command: "console",
            success: true,
            runId,
            source: expect.stringMatching(/stdout|stderr/),
          }),
        ]),
      );

      const network = JSON.parse(
        (
          await execa(controller, ["cli", "network-summary", "--run", runId, "--json"], {
            cwd: projectRoot,
          })
        ).stdout,
      );
      expect(network).toMatchObject({
        command: "network-summary",
        success: true,
        runId,
        network: { port: expect.any(Number), listening: false, pid: null },
      });

      const settled = JSON.parse(
        (
          await execa(
            controller,
            [
              "cli",
              "wait-settle",
              "--run",
              runId,
              "--timeout-ms",
              "1000",
              "--interval-ms",
              "20",
              "--json",
            ],
            { cwd: projectRoot },
          )
        ).stdout,
      );
      expect(settled).toMatchObject({
        command: "wait-settle",
        success: true,
        runId,
        settled: true,
        lifecycle: { childrenRunning: [], serverListening: false, durableStateStable: true },
      });

      const cancellation = JSON.parse(
        (
          await execa(controller, ["cli", "cancel", "--run", runId, "--dry-run", "--json"], {
            cwd: projectRoot,
          })
        ).stdout,
      );
      expect(cancellation).toMatchObject({
        command: "cancel",
        success: true,
        dryRun: true,
        ownedProcesses: [],
      });
    } finally {
      await execa(controller, ["cli", "cleanup", "--run", runId, "--json"], {
        cwd: projectRoot,
      });
    }

    expect(executed.result).toBe("VERIFIED");
  }, 30_000);

  it("binds a Codex response to report, database, repository, and child teardown evidence", async () => {
    const runId = `controller-codex-test-${process.pid}-${Date.now()}`;
    const mockBin = await mkdtemp(join(tmpdir(), "control-diffowl-codex-"));
    const mockExecutable = join(mockBin, "codex");
    const mockModule = join(projectRoot, "src", "codex", "fixtures", "mock-codex-cli.mjs");
    await writeFile(
      mockExecutable,
      [
        `#!${process.execPath}`,
        `(async () => import(${JSON.stringify(pathToFileURL(mockModule).href)}))().catch((error) => {`,
        "  console.error(error);",
        "  process.exit(1);",
        "});",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    let executed;
    try {
      executed = JSON.parse(
        (
          await execa(
            controller,
            [
              "run",
              "codex",
              "codex-review-staged",
              "--run-id",
              runId,
              "--model",
              "gpt-5-codex",
              "--json",
            ],
            {
              cwd: projectRoot,
              env: {
                DIFFOWL_CODEX_EXECUTABLE: mockExecutable,
                MOCK_APP_SERVER_MODE: "spike-marker",
                MOCK_APP_SERVER_MODEL: "gpt-5-codex",
              },
            },
          )
        ).stdout,
      );
      expect(executed).toMatchObject({
        command: "run",
        success: true,
        surface: "codex",
        result: "VERIFIED",
        verification: {
          behavior: true,
          report: true,
          database: true,
          repositoryImmutable: true,
          teardown: true,
        },
      });

      const receipt = JSON.parse(await readReceipt(executed.receipt));
      expect(receipt).toMatchObject({
        result: "VERIFIED",
        target: { runtime: expect.stringContaining('"effectiveModel":"gpt-5-codex"') },
        actions: expect.arrayContaining([
          expect.objectContaining({ command: expect.stringContaining("--backend codex") }),
        ]),
        observed: expect.arrayContaining([
          expect.objectContaining({ check: "structured review document", ok: true }),
          expect.objectContaining({ check: "immutable report persisted", ok: true }),
          expect.objectContaining({ check: "database review agrees", ok: true }),
          expect.objectContaining({ check: "owned process teardown", ok: true }),
        ]),
        cleanup: { running: [] },
        artifacts: expect.arrayContaining([
          expect.stringMatching(/durable\/\d+-review-.*\.md$/),
          expect.stringMatching(/durable\/\d+-state\.db$/),
        ]),
      });
    } finally {
      if (executed) {
        await execa(controller, ["codex", "cleanup", "--run", runId, "--json"], {
          cwd: projectRoot,
        });
      }
      await rm(mockBin, { recursive: true, force: true });
    }
  }, 30_000);
});

async function readReceipt(path) {
  return readFile(path, "utf8");
}
