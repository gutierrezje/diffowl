import { readFile, writeFile } from "node:fs/promises";

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
