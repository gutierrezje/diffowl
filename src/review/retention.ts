import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REVIEW_FILE_PATTERN = /^review-.+\.md$/;

export async function pruneReviewReports(dir: string, maxReports: number): Promise<void> {
  if (maxReports === 0) return;

  try {
    const files = (await readdir(dir))
      .filter((file) => REVIEW_FILE_PATTERN.test(file))
      .sort()
      .reverse();

    await Promise.all(files.slice(maxReports).map((file) => unlink(join(dir, file))));
  } catch {
    // Retention is best-effort and must not fail a completed review.
  }
}

export async function trimHookLog(logFile: string, maxBytes: number): Promise<void> {
  if (maxBytes === 0) return;

  try {
    const content = await readFile(logFile);
    if (content.length <= maxBytes) return;

    await writeFile(logFile, content.subarray(content.length - maxBytes));
  } catch {
    // Missing or unreadable logs do not prevent the next hook review.
  }
}
