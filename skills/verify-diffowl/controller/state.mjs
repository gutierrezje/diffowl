import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { digest, inspectProcess, pathExists, runCommand } from "./system.mjs";

export async function captureState(run) {
  const [git, database, processes, reviews] = await Promise.all([
    captureGit(run.manifest.scratch),
    captureDatabase(run.manifest.scratch),
    captureProcesses(run.manifest),
    captureReviews(run.manifest.scratch),
  ]);
  return { git, database, processes, reviews };
}

export async function captureGit(scratch) {
  const [head, status, tracked, stagedDiff, workingDiff] = await Promise.all([
    runCommand("git", ["-C", scratch, "rev-parse", "HEAD"]),
    runCommand("git", ["-C", scratch, "status", "--porcelain=v1", "--ignored"]),
    runCommand("git", ["-C", scratch, "ls-files", "--stage"]),
    runCommand("git", ["-C", scratch, "diff", "--cached", "--binary"]),
    runCommand("git", ["-C", scratch, "diff", "--binary"]),
  ]);
  return {
    head: head.stdout,
    status: status.stdout ? status.stdout.split("\n") : [],
    trackedStateHash: digest(tracked.stdout),
    stagedDiffHash: digest(stagedDiff.stdout),
    workingDiffHash: digest(workingDiff.stdout),
  };
}

async function captureDatabase(scratch) {
  const stateDir = join(scratch, ".diffowl");
  if (!(await pathExists(stateDir))) {
    return { present: false, files: [] };
  }
  const entries = await readdir(stateDir);
  const files = [];
  for (const name of entries.filter((entry) => /\.(?:db|sqlite|sqlite3)$/.test(entry))) {
    const path = join(stateDir, name);
    const details = await stat(path);
    files.push({
      name,
      bytes: details.size,
      hash: digest(await readFile(path)),
      ...(await inspectDatabase(path)),
    });
  }
  const sidecars = [];
  for (const name of entries.filter((entry) => /-(?:wal|shm)$/.test(entry))) {
    const path = join(stateDir, name);
    const details = await stat(path);
    sidecars.push({ name, bytes: details.size, hash: digest(await readFile(path)) });
  }
  return { present: files.length > 0, files, sidecars };
}

async function inspectDatabase(path) {
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(path, { readOnly: true });
    const tableRows = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const tables = tableRows.map(({ name }) => {
      const quoted = String(name).replaceAll('"', '""');
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get();
      return { name, rows: Number(row?.count ?? 0) };
    });
    return { tables };
  } catch (error) {
    return { tables: [], inspectionError: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
}

async function captureProcesses(manifest) {
  const ownedProcesses = Array.isArray(manifest.ownedProcesses) ? manifest.ownedProcesses : [];
  return Promise.all(
    ownedProcesses.map(async (owned) => ({ ...owned, ...(await inspectProcess(owned.pid)) })),
  );
}

async function captureReviews(scratch) {
  const reviewsDir = join(scratch, ".diffowl", "reviews");
  if (!(await pathExists(reviewsDir))) {
    return [];
  }
  const entries = await readdir(reviewsDir, { recursive: true, withFileTypes: true });
  const reviews = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const details = await stat(path);
    reviews.push({
      name: basename(path),
      path,
      bytes: details.size,
      hash: digest(await readFile(path)),
    });
  }
  return reviews.sort((left, right) => left.path.localeCompare(right.path));
}
