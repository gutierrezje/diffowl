import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCodexProtocol } from "./protocol-evidence.js";

const fixture = fileURLToPath(new URL("./fixtures/mock-codex-cli.mjs", import.meta.url));
const HUMAN_GATED_TEST_TIMEOUT_MS = 900_000;

describe("inspectCodexProtocol", () => {
  it("captures compatible 0.147.0 generated protocol evidence and removes generated output", async () => {
    const markerDirectory = await mkdtemp(join(tmpdir(), "codex-protocol-marker-"));
    const markerFile = join(markerDirectory, "generated-root");
    try {
      const evidence = await inspectCodexProtocol({
        executable: process.execPath,
        prefixArgs: [fixture],
        env: { MOCK_CLI_MARKER_FILE: markerFile },
        timeoutMs: 5_000,
      });
      expect(evidence).toMatchObject({
        codexCliVersion: "codex-cli 0.147.0",
        generatedWithoutExperimentalApi: true,
        typesFileCount: 642,
        jsonSchemaFileCount: 285,
      });
      expect(evidence.typesSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.jsonSchemaSha256).toMatch(/^[0-9a-f]{64}$/);
      const generatedRoot = await readFile(markerFile, "utf8");
      await expect(access(generatedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(markerDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing-file", { MOCK_CLI_MISSING: "ClientRequest.ts" }, "ClientRequest.ts"],
    ["missing-token", { MOCK_CLI_MISSING_FRAGMENT: "turn/interrupt" }, "turn/interrupt"],
  ])("rejects incompatible generated output for %s", async (_mode, env, detail) => {
    await expect(
      inspectCodexProtocol({
        executable: process.execPath,
        prefixArgs: [fixture],
        env,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      kind: "protocol-incompatible",
      message: expect.stringContaining(detail),
    });
  });

  it.each(["incompatible-shape", "incompatible-nesting"])(
    "rejects token-preserving JSON that is not a compatible schema (%s)",
    async (mode) => {
      await expect(
        inspectCodexProtocol({
          executable: process.execPath,
          prefixArgs: [fixture],
          env: { MOCK_CLI_MODE: mode },
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({
        kind: "protocol-incompatible",
        message: expect.stringContaining("TurnStartParams.json"),
      });
    },
  );

  it("reports a missing executable", async () => {
    const executable = join(tmpdir(), `diffowl-missing-codex-${randomUUID()}`);
    await expect(inspectCodexProtocol({ executable, timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "executable-missing",
    });
  });

  it("resolves a bare executable through the sanitized PATH", async () => {
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const executable =
      process.platform === "win32"
        ? basename(process.execPath, extname(process.execPath))
        : basename(process.execPath);
    const evidence = await inspectCodexProtocol({
      executable,
      prefixArgs: [fixture],
      env: { [pathKey]: dirname(process.execPath) },
      timeoutMs: 5_000,
    });
    expect(evidence.codexCliVersion).toBe("codex-cli 0.147.0");
  });

  it.skipIf(process.platform === "win32")(
    "skips a non-executable PATH candidate during protocol inspection",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "diffowl-protocol-path-"));
      const first = join(root, "first");
      const second = join(root, "second");
      const executable = "codex-test";
      try {
        await Promise.all([mkdir(first), mkdir(second)]);
        await writeFile(join(first, executable), "not executable");
        await chmod(join(first, executable), 0o644);
        await symlink(process.execPath, join(second, executable));

        const evidence = await inspectCodexProtocol({
          executable,
          prefixArgs: [fixture],
          env: { PATH: `${first}:${second}` },
          timeoutMs: 5_000,
        });

        expect(evidence.codexCliVersion).toBe("codex-cli 0.147.0");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an invalid version", async () => {
    await expect(
      inspectCodexProtocol({
        executable: process.execPath,
        prefixArgs: [fixture],
        env: { MOCK_CLI_MODE: "invalid-version" },
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ kind: "protocol-incompatible" });
  });

  it("hashes extra generated files even when paths and counts are unchanged", async () => {
    const first = await inspectCodexProtocol({
      executable: process.execPath,
      prefixArgs: [fixture],
      env: { MOCK_CLI_EXTRA_VARIANT: "first" },
      timeoutMs: 5_000,
    });
    const second = await inspectCodexProtocol({
      executable: process.execPath,
      prefixArgs: [fixture],
      env: { MOCK_CLI_EXTRA_VARIANT: "second" },
      timeoutMs: 5_000,
    });
    expect(second.typesFileCount).toBe(first.typesFileCount);
    expect(second.jsonSchemaFileCount).toBe(first.jsonSchemaFileCount);
    expect(second.typesSha256).not.toBe(first.typesSha256);
    expect(second.jsonSchemaSha256).not.toBe(first.jsonSchemaSha256);
  });

  it("reports bounded redacted generator stderr", async () => {
    const error = await inspectCodexProtocol({
      executable: process.execPath,
      prefixArgs: [fixture],
      env: { MOCK_CLI_MODE: "fail-generate", MOCK_CLI_STDERR_VALUE: "secret-token" },
      timeoutMs: 5_000,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: "generation-failed", phase: "generate-ts" });
    if (!isRecord(error) || typeof error["stderr"] !== "string")
      throw new Error("missing bounded stderr");
    expect(error["stderr"]).not.toContain("secret-token");
    expect(error["stderr"].length).toBeLessThanOrEqual(4_096);
  });

  it("terminates a hung generator and reports its phase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-pid-"));
    const pidFile = join(directory, "pid");
    const controller = new AbortController();
    try {
      const error = await inspectCodexProtocol({
        executable: process.execPath,
        prefixArgs: [fixture],
        env: { MOCK_CLI_MODE: "hang-generate", MOCK_CLI_PID_FILE: pidFile },
        timeoutMs: 3_000,
        signal: controller.signal,
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ kind: "timeout", phase: "generate-ts" });
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels an active protocol generator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-cancelled-"));
    const pidFile = join(directory, "pid");
    const controller = new AbortController();
    try {
      const inspection = inspectCodexProtocol({
        executable: process.execPath,
        prefixArgs: [fixture],
        env: { MOCK_CLI_MODE: "hang-generate", MOCK_CLI_PID_FILE: pidFile },
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 100);

      await expect(inspection).rejects.toMatchObject({ kind: "cancelled" });
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env["DIFFOWL_CODEX_PROTOCOL_LIVE"] !== "1")(
    "matches the installed Codex 0.147.0 manifest",
    { timeout: HUMAN_GATED_TEST_TIMEOUT_MS },
    async () => {
      const evidence = await inspectCodexProtocol({
        executable: process.env["DIFFOWL_CODEX_EXECUTABLE"] ?? "codex",
        ...(process.env["DIFFOWL_CODEX_PREFIX_ARGS"] === undefined
          ? {}
          : { prefixArgs: process.env["DIFFOWL_CODEX_PREFIX_ARGS"].split(" ").filter(Boolean) }),
        timeoutMs: 30_000,
      });
      expect(evidence.codexCliVersion).toBe("codex-cli 0.147.0");
      expect(evidence.typesFileCount).toBe(642);
      expect(evidence.jsonSchemaFileCount).toBe(285);
      expect(evidence.typesSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.jsonSchemaSha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
