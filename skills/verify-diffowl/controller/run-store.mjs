import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ControllerError } from "./errors.mjs";
import { pathExists } from "./system.mjs";
import { z } from "zod";

export const verificationRoot = resolve(import.meta.dirname, "../../../artifacts/verification");
const indexRoot = join(verificationRoot, "runs");
const RunIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

export function validateRunId(runId, command) {
  const parsed = RunIdSchema.safeParse(runId);
  if (parsed.success) return parsed.data;
  throw new ControllerError({
    command,
    expected: "--run <id> using letters, digits, dot, underscore, or dash",
    observed: runId ?? "missing run ID",
    likelyCause: "The command could not identify one owned verification run.",
    nextAction: "Create a run with new-run or copy its run ID from receipt output.",
    exitCode: 2,
  });
}

export function makeRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

export async function saveRunIndex(runId, value) {
  await mkdir(indexRoot, { recursive: true });
  await writeJsonAtomic(join(indexRoot, `${runId}.json`), value);
}

export async function loadRun(runId, command) {
  validateRunId(runId, command);
  const indexPath = join(indexRoot, `${runId}.json`);
  if (!(await pathExists(indexPath))) {
    const discovered = await discoverRun(runId);
    if (discovered) {
      await saveRunIndex(runId, discovered);
    }
  }
  if (!(await pathExists(indexPath))) {
    throw new ControllerError({
      command,
      expected: `a recorded run named ${runId}`,
      observed: "no run index or evidence receipt",
      likelyCause: "The run ID is wrong, evidence was moved, or new-run did not complete.",
      nextAction: "Inspect artifacts/verification or create a new isolated run.",
    });
  }

  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const manifest = JSON.parse(await readFile(join(index.evidence, "manifest.json"), "utf8"));
  return { ...index, manifest, indexPath };
}

export async function loadSurfaceRun(adapter, runIdInput, command) {
  const runId = validateRunId(runIdInput, command);
  const run = await loadRun(runId, command);
  if (run.manifest.surface !== adapter.surface) {
    throw new ControllerError({
      command,
      expected: `a ${adapter.surface} run`,
      observed: `${run.manifest.surface} run ${runId}`,
      likelyCause: "The command used a different surface than the recorded run.",
      nextAction: `Retry with control-diffowl ${run.manifest.surface} ${command} --run ${runId}.`,
      exitCode: 2,
    });
  }
  return run;
}

export async function readReceipt(run) {
  return JSON.parse(await readFile(join(run.evidence, "receipt.json"), "utf8"));
}

export async function writeManifest(run, manifest) {
  await writeJsonAtomic(join(run.evidence, "manifest.json"), manifest);
}

export async function writeReceipt(run, receipt) {
  await writeJsonAtomic(join(run.evidence, "receipt.json"), receipt);
}

export async function updateReceipt(run, update) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(run.evidence, "controller-lock.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(
      "CREATE TABLE IF NOT EXISTS receipt_lease (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)",
    );
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT OR REPLACE INTO receipt_lease (id, token) VALUES (1, ?)").run(
      randomUUID(),
    );
    const receipt = await readReceipt(run);
    const updated = (await update(receipt)) ?? receipt;
    await writeReceipt(run, updated);
    database.exec("COMMIT");
    return updated;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The failure happened before a transaction began.
    }
    if (error instanceof Error && /database is locked/i.test(error.message)) {
      throw new ControllerError({
        command: "receipt",
        expected: "exclusive access to the run receipt",
        observed: `receipt lease remained busy for run ${run.manifest.runId}`,
        likelyCause: "Another controller process is still updating this run's evidence.",
        nextAction: "Wait for the active command to settle, then retry the inspection.",
      });
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function writeJsonExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function parseLegacyReceipt(path) {
  const text = await readFile(path, "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function discoverRun(runId) {
  if (!(await pathExists(verificationRoot))) {
    return null;
  }
  const entries = await readdir(verificationRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "run-id.txt") {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, "utf8")).trim() === runId) {
      const evidence = entry.parentPath;
      const receipt = await parseLegacyReceipt(join(evidence, "receipt.txt"));
      return { schemaVersion: 1, runId, surface: receipt.surface, evidence };
    }
  }
  return null;
}
