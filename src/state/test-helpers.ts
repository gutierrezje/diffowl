import { rm } from "node:fs/promises";
import { getStateDbPath } from "./db.js";
import { isRetryableFsError, removeTempDir } from "../test/helpers.js";

export async function removeTempStateDir(dir: string): Promise<void> {
  const dbPath = getStateDbPath(dir);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dbPath, { force: true });
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await removeTempDir(dir);
      return;
    } catch (error) {
      if (!isRetryableFsError(error) || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
