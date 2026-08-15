import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function trimHookLog(logFile: string, maxBytes: number): Promise<void> {
  if (maxBytes === 0) return;

  try {
    const content = await readFile(logFile, "utf-8");
    if (Buffer.byteLength(content, "utf-8") <= maxBytes) return;

    const characters = Array.from(content);
    let start = characters.length;
    let byteLength = 0;
    while (start > 0) {
      const character = characters[start - 1]!;
      const characterBytes = Buffer.byteLength(character, "utf-8");
      if (byteLength + characterBytes > maxBytes) break;
      byteLength += characterBytes;
      start--;
    }

    const temporaryFile = join(
      dirname(logFile),
      `.${basename(logFile)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryFile, characters.slice(start).join(""), "utf-8");
      await rename(temporaryFile, logFile);
    } finally {
      await unlink(temporaryFile).catch(() => undefined);
    }
  } catch {
    // Missing or unreadable logs do not prevent the next hook review.
  }
}
