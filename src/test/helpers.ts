import { rm } from "node:fs/promises";
import { z } from "zod";

const RetryableFsErrorSchema = z.object({ code: z.enum(["EBUSY", "EPERM"]) });

export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableFsError(error) || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export function isRetryableFsError(cause: unknown): boolean {
  return RetryableFsErrorSchema.safeParse(cause).success;
}
