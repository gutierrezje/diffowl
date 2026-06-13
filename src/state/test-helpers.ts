import { rm } from "node:fs/promises";
import { getStateDbPath } from "./db.js";

export async function removeTempStateDir(dir: string): Promise<void> {
  const dbPath = getStateDbPath(dir);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dbPath, { force: true });
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable =
        error instanceof Error &&
        (error.message.includes("EBUSY") || error.message.includes("EPERM"));
      if (!retryable || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
