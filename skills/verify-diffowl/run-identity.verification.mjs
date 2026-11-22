import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "../..");
const controller = join(import.meta.dirname, "control-diffowl");
const experimentRoot = join(projectRoot, "artifacts", "verification", "identity-experiment");

describe("run identity binding", () => {
  it("keeps an unchanged dirty source bound to the run", async () => {
    const runId = `identity-dirty-control-${process.pid}-${Date.now()}`;
    const fixturePath = join(projectRoot, `${runId}.fixture`);
    const contents = Buffer.from("stable dirty fixture\n");
    let created = false;
    await writeFile(fixturePath, contents);
    try {
      await createRun(runId);
      created = true;
      const execution = await executeRun(runId);
      const output = JSON.parse(execution.stdout);
      const receipt = await readRunReceipt(runId);
      const beforeSha256 = sha256(contents);
      const afterSha256 = sha256(await readFile(fixturePath));
      await recordExperiment(runId, {
        case: "unchanged-dirty-control",
        fixture: { path: fixturePath, beforeSha256, afterSha256 },
        verifier: { exitCode: execution.exitCode, output },
        receipt,
      });

      expect(beforeSha256).toBe(afterSha256);
      expect(output).toMatchObject({ success: true, result: "VERIFIED" });
      expect(output.verification.identityBound).toBe(true);
      expect(receipt.observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "run source content identity",
            ok: true,
            phase: "preflight",
          }),
          expect.objectContaining({
            check: "run source content identity",
            ok: true,
            phase: "postflight",
          }),
        ]),
      );
    } finally {
      if (created) await cleanupRun(runId);
      await rm(fixturePath, { force: true });
    }
  }, 30_000);

  it("blocks source drift before actions without requiring a doctor preflight", async () => {
    const runId = `identity-source-drift-${process.pid}-${Date.now()}`;
    const fixturePath = join(projectRoot, `${runId}.fixture`);
    const before = Buffer.from("bound source\n");
    const after = Buffer.from("changed source\n");
    let created = false;
    await writeFile(fixturePath, before);
    try {
      await execa(controller, ["cli", "new-run", "cli-version-help", "--run-id", runId, "--json"], {
        cwd: projectRoot,
      });
      created = true;
      await writeFile(fixturePath, after);

      const execution = await execa(
        controller,
        ["run", "cli", "cli-version-help", "--run", runId, "--json"],
        { cwd: projectRoot, reject: false },
      );
      const output = JSON.parse(execution.stdout);
      const doctor = await execa(controller, ["cli", "doctor", "--run", runId, "--json"], {
        cwd: projectRoot,
        reject: false,
      });
      const doctorOutput = JSON.parse(doctor.stdout);
      const receiptResult = await execa(controller, ["cli", "receipt", "--run", runId, "--json"], {
        cwd: projectRoot,
      });
      const receipt = JSON.parse(receiptResult.stdout);
      const beforeSha256 = createHash("sha256").update(before).digest("hex");
      const afterSha256 = createHash("sha256")
        .update(await readFile(fixturePath))
        .digest("hex");
      await recordExperiment(runId, {
        case: "source-drift",
        fixture: { path: fixturePath, beforeSha256, afterSha256 },
        verifier: { exitCode: execution.exitCode, output },
        independentDoctor: { exitCode: doctor.exitCode, problems: doctorOutput.problems },
        receipt,
      });

      expect(beforeSha256).not.toBe(afterSha256);
      expect(execution.exitCode).not.toBe(0);
      expect(output).toMatchObject({ success: false, result: "INCONCLUSIVE" });
      expect(receipt.observed).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ check: "feature execution completed" })]),
      );
      expect(doctor.exitCode).not.toBe(0);
      expect(doctorOutput.problems).toContain(
        "run source content identity no longer matches checkout",
      );
      expect(receipt).toMatchObject({
        result: "INCONCLUSIVE",
        controller: { state: "failed" },
        actions: [],
        confounds: [
          expect.objectContaining({
            observed: expect.stringContaining("source content identity"),
          }),
        ],
      });
    } finally {
      if (created) {
        await execa(controller, ["cli", "cleanup", "--run", runId, "--json"], {
          cwd: projectRoot,
          reject: false,
        });
      }
      await rm(fixturePath, { force: true });
    }
  }, 30_000);

  it("blocks behavior-neutral binary drift before actions", async () => {
    const runId = `identity-binary-drift-${process.pid}-${Date.now()}`;
    let created = false;
    let originalBinary;
    try {
      await createRun(runId);
      created = true;
      const manifest = await readRunManifest(runId);
      originalBinary = await readFile(manifest.binaryPath);
      await writeFile(
        manifest.binaryPath,
        Buffer.concat([originalBinary, Buffer.from("\n// identity-only drift\n")]),
      );

      const execution = await executeRun(runId);
      const output = JSON.parse(execution.stdout);
      const doctor = await doctorRun(runId);
      const receipt = await readRunReceipt(runId);
      await recordExperiment(runId, {
        case: "behavior-neutral-binary-drift",
        fixture: {
          path: manifest.binaryPath,
          beforeSha256: sha256(originalBinary),
          afterSha256: sha256(await readFile(manifest.binaryPath)),
        },
        verifier: { exitCode: execution.exitCode, output },
        independentDoctor: { exitCode: doctor.exitCode, problems: doctor.output.problems },
        receipt,
      });

      expect(output).toMatchObject({
        success: false,
        result: "INCONCLUSIVE",
        verification: { identityBound: false },
      });
      expect(execution.exitCode).not.toBe(0);
      expect(receipt.actions).toEqual([]);
      expect(receipt.confounds[0].observed).toContain(
        "run artifact no longer matches current binary",
      );
      expect(doctor.exitCode).not.toBe(0);
      expect(doctor.output.problems).toContain("run artifact no longer matches current binary");
    } finally {
      if (originalBinary)
        await writeFile((await readRunManifest(runId)).binaryPath, originalBinary);
      if (created) await cleanupRun(runId);
    }
  }, 30_000);

  it("fails closed without product actions when the recorded binary is unavailable", async () => {
    const runId = `identity-binary-unavailable-${process.pid}-${Date.now()}`;
    let created = false;
    let movedBinary = false;
    let manifest;
    let backupPath;
    let originalBinary;
    try {
      await createRun(runId);
      created = true;
      manifest = await readRunManifest(runId);
      backupPath = `${manifest.binaryPath}.${runId}.unavailable`;
      originalBinary = await readFile(manifest.binaryPath);
      await rename(manifest.binaryPath, backupPath);
      movedBinary = true;

      const execution = await executeRun(runId);
      const output = JSON.parse(execution.stdout);
      const receipt = await readRunReceipt(runId);
      let binaryStillPresent = true;
      try {
        await access(manifest.binaryPath);
      } catch {
        binaryStillPresent = false;
      }
      const retainedBinary = await readFile(backupPath);
      await recordExperiment(runId, {
        case: "recorded-binary-unavailable",
        fixture: {
          path: manifest.binaryPath,
          beforeSha256: sha256(originalBinary),
          afterPresent: binaryStillPresent,
          retainedSha256: sha256(retainedBinary),
        },
        verifier: { exitCode: execution.exitCode, output },
        receipt,
      });

      expect(binaryStillPresent).toBe(false);
      expect(sha256(retainedBinary)).toBe(sha256(originalBinary));
      expect(execution.exitCode).not.toBe(0);
      expect(output).toMatchObject({
        success: false,
        result: "INCONCLUSIVE",
        verification: { identityBound: false },
      });
      expect(receipt).toMatchObject({
        result: "INCONCLUSIVE",
        controller: { state: "failed" },
        actions: [],
        confounds: [
          expect.objectContaining({
            observed: expect.stringContaining("run binary artifact identity unavailable"),
          }),
        ],
      });
    } finally {
      if (movedBinary) await rename(backupPath, manifest.binaryPath);
      if (created) await cleanupRun(runId);
    }
  }, 30_000);

  it("blocks controller wrapper drift before actions", async () => {
    const runId = `identity-controller-drift-${process.pid}-${Date.now()}`;
    let created = false;
    let originalController;
    try {
      await createRun(runId);
      created = true;
      const manifest = await readRunManifest(runId);
      originalController = await readFile(manifest.controllerPath);
      await writeFile(
        manifest.controllerPath,
        Buffer.concat([originalController, Buffer.from("\n# identity-only drift\n")]),
      );

      const execution = await executeRun(runId);
      const output = JSON.parse(execution.stdout);
      const doctor = await doctorRun(runId);
      const receipt = await readRunReceipt(runId);
      await recordExperiment(runId, {
        case: "controller-wrapper-drift",
        fixture: {
          path: manifest.controllerPath,
          beforeSha256: sha256(originalController),
          afterSha256: sha256(await readFile(manifest.controllerPath)),
        },
        verifier: { exitCode: execution.exitCode, output },
        independentDoctor: { exitCode: doctor.exitCode, problems: doctor.output.problems },
        receipt,
      });

      expect(output).toMatchObject({ success: false, result: "INCONCLUSIVE" });
      expect(execution.exitCode).not.toBe(0);
      expect(receipt.actions).toEqual([]);
      expect(receipt.confounds[0].observed).toContain(
        "run controller artifact no longer matches checkout",
      );
      expect(doctor.exitCode).not.toBe(0);
      expect(doctor.output.problems).toContain(
        "run controller artifact no longer matches checkout",
      );
    } finally {
      if (originalController) {
        await writeFile((await readRunManifest(runId)).controllerPath, originalController);
      }
      if (created) await cleanupRun(runId);
    }
  }, 30_000);

  it("returns inconclusive after in-run source drift and preserves feature evidence", async () => {
    const runId = `identity-in-run-drift-${process.pid}-${Date.now()}`;
    const fixturePath = join(projectRoot, `${runId}.fixture`);
    const shimDir = join(experimentRoot, `${runId}-bin`);
    const shimPath = join(shimDir, "node");
    const shimModulePath = join(experimentRoot, `${runId}-node.mjs`);
    const before = Buffer.from("source before feature\n");
    const after = Buffer.from("source changed during feature\n");
    let created = false;
    await writeFile(fixturePath, before);
    try {
      await createRun(runId);
      created = true;
      const manifest = await readRunManifest(runId);
      const shim = [
        'import { writeFile } from "node:fs/promises";',
        'import { execa } from "execa";',
        `const fixturePath = ${JSON.stringify(fixturePath)};`,
        `const binaryPath = ${JSON.stringify(manifest.binaryPath)};`,
        `const realNode = ${JSON.stringify(process.execPath)};`,
        `const args = process.argv.slice(2);`,
        `const isHelpAction = args[0] === binaryPath && args[1] === "--help";`,
        `const result = await execa(realNode, args, { reject: false });`,
        `if (result.stdout) process.stdout.write(result.stdout);`,
        `if (result.stderr) process.stderr.write(result.stderr);`,
        `if (isHelpAction && result.exitCode === 0) await writeFile(fixturePath, ${JSON.stringify(after.toString())});`,
        `process.exitCode = result.exitCode ?? 1;`,
        "",
      ].join("\n");
      await mkdir(experimentRoot, { recursive: true });
      await mkdir(shimDir, { recursive: true });
      await writeFile(shimModulePath, shim);
      await writeFile(
        shimPath,
        `#!/bin/sh\nexec "${process.execPath}" "${shimModulePath}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
      const execution = await execa(
        controller,
        ["run", "cli", "cli-version-help", "--run", runId, "--json"],
        {
          cwd: projectRoot,
          reject: false,
          env: { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH}` },
        },
      );
      const output = JSON.parse(execution.stdout);
      const doctor = await doctorRun(runId);
      const receipt = await readRunReceipt(runId);
      const beforeSha256 = sha256(before);
      const afterSha256 = sha256(await readFile(fixturePath));
      await recordExperiment(runId, {
        case: "source-drift-during-feature",
        fixture: { path: fixturePath, beforeSha256, afterSha256, shimPath },
        verifier: { exitCode: execution.exitCode, output },
        independentDoctor: { exitCode: doctor.exitCode, problems: doctor.output.problems },
        receipt,
      });

      expect(beforeSha256).not.toBe(afterSha256);
      expect(output).toMatchObject({
        success: false,
        result: "INCONCLUSIVE",
        verification: { identityBound: false, artifactsPreserved: true },
      });
      expect(execution.exitCode).not.toBe(0);
      expect(receipt.controller.state).toBe("completed");
      expect(receipt.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: "diffowl -V" }),
          expect.objectContaining({ command: "diffowl --help" }),
        ]),
      );
      expect(receipt.observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "run source content identity",
            phase: "postflight",
            ok: false,
          }),
        ]),
      );
      expect(doctor.output.problems).toContain(
        "run source content identity no longer matches checkout",
      );
    } finally {
      if (created) await cleanupRun(runId);
      await rm(fixturePath, { force: true });
      await rm(shimDir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(
    [
      {
        command: "new-run",
        args: (runId) => ["cli", "new-run", "cli-version-help", "--run-id", runId, "--json"],
      },
      {
        command: "run",
        args: (runId) => ["run", "cli", "cli-version-help", "--run-id", runId, "--json"],
      },
    ].flatMap((entry) => [true, false].map((json) => ({ ...entry, json }))),
  )(
    "fails $command (json=$json) when source changes while the helper builds the binary",
    async ({ command, args, json }) => {
      const runId = `identity-build-drift-${command}-${process.pid}-${Date.now()}`;
      const fixturePath = join(projectRoot, `${runId}.fixture`);
      const shimDir = join(experimentRoot, `${runId}-bin`);
      const shimPath = join(shimDir, "bash");
      const shimModulePath = join(experimentRoot, `${runId}-bash.mjs`);
      const helperPath = join(import.meta.dirname, "helpers/scratch-repo.sh");
      const before = Buffer.from("source before helper build\n");
      const after = Buffer.from("source changed after helper build\n");
      let created = false;
      await writeFile(fixturePath, before);
      try {
        const shim = [
          'import { writeFile } from "node:fs/promises";',
          'import { execa } from "execa";',
          `const helperPath = ${JSON.stringify(helperPath)};`,
          `const fixturePath = ${JSON.stringify(fixturePath)};`,
          'const realBash = "/bin/bash";',
          "const args = process.argv.slice(2);",
          "const result = await execa(realBash, args, { reject: false });",
          "if (result.stdout) process.stdout.write(result.stdout);",
          "if (result.stderr) process.stderr.write(result.stderr);",
          "if (args[0] === helperPath && result.exitCode === 0) await writeFile(fixturePath, " +
            `${JSON.stringify(after.toString())});`,
          "process.exitCode = result.exitCode ?? 1;",
          "",
        ].join("\n");
        await mkdir(experimentRoot, { recursive: true });
        await mkdir(shimDir, { recursive: true });
        await writeFile(shimModulePath, shim);
        await writeFile(
          shimPath,
          `#!/bin/sh\nexec "${process.execPath}" "${shimModulePath}" "$@"\n`,
          {
            mode: 0o755,
          },
        );

        const execution = await execa(
          controller,
          args(runId).filter((arg) => json || arg !== "--json"),
          {
            cwd: projectRoot,
            reject: false,
            env: { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH}` },
          },
        );
        const output = json ? JSON.parse(execution.stdout) : execution.stdout;
        const receiptResult = await execa(
          controller,
          ["cli", "receipt", "--run", runId, "--json"],
          { cwd: projectRoot, reject: false },
        );
        created = receiptResult.exitCode === 0;
        const receipt = created ? JSON.parse(receiptResult.stdout) : null;
        const beforeSha256 = sha256(before);
        const afterSha256 = sha256(await readFile(fixturePath));
        await recordExperiment(runId, {
          case: "source-drift-during-build",
          fixture: { path: fixturePath, beforeSha256, afterSha256 },
          shim: { path: shimPath, modulePath: shimModulePath },
          verifier: { exitCode: execution.exitCode, output },
          receipt,
        });

        expect(beforeSha256).not.toBe(afterSha256);
        expect(execution.exitCode).not.toBe(0);
        if (json) {
          expect(output).toMatchObject({ command, success: false, result: "INCONCLUSIVE" });
        } else {
          expect(output).toContain("INCONCLUSIVE:");
          expect(output).toContain("Receipt:");
          expect(output).toContain("Source changed or became unreadable");
        }
        if (json && command === "run") {
          expect(output).toMatchObject({
            evidence: expect.any(String),
            receipt: expect.stringContaining("receipt.json"),
            verification: { identityBound: false },
            error: { expected: expect.stringContaining("source identity to remain unchanged") },
          });
        }
        expect(receipt).toMatchObject({
          result: "INCONCLUSIVE",
          controller: { state: "failed" },
          actions: [],
          observed: expect.arrayContaining([
            expect.objectContaining({ check: "source identity stable across build", ok: false }),
          ]),
        });
      } finally {
        if (created) await cleanupRun(runId);
        await rm(fixturePath, { force: true });
        await rm(shimDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

async function createRun(runId) {
  await execa(controller, ["cli", "new-run", "cli-version-help", "--run-id", runId, "--json"], {
    cwd: projectRoot,
  });
}

async function executeRun(runId, env = process.env) {
  return execa(controller, ["run", "cli", "cli-version-help", "--run", runId, "--json"], {
    cwd: projectRoot,
    reject: false,
    env,
  });
}

async function doctorRun(runId) {
  const result = await execa(controller, ["cli", "doctor", "--run", runId, "--json"], {
    cwd: projectRoot,
    reject: false,
  });
  return { ...result, output: JSON.parse(result.stdout) };
}

async function readRunReceipt(runId) {
  const result = await execa(controller, ["cli", "receipt", "--run", runId, "--json"], {
    cwd: projectRoot,
  });
  return JSON.parse(result.stdout);
}

async function readRunManifest(runId) {
  const receipt = await readRunReceipt(runId);
  return JSON.parse(await readFile(join(receipt.artifacts[0], "manifest.json"), "utf8"));
}

async function cleanupRun(runId) {
  await execa(controller, ["cli", "cleanup", "--run", runId, "--json"], {
    cwd: projectRoot,
    reject: false,
  });
}

async function recordExperiment(runId, result) {
  await mkdir(experimentRoot, { recursive: true });
  await writeFile(
    join(experimentRoot, `${runId}.json`),
    `${JSON.stringify({ runId, ...result }, null, 2)}\n`,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
