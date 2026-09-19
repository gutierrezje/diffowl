import { readFile } from "node:fs/promises";
import { z } from "zod";

const PackageVersionSchema = z.object({ version: z.string().min(1) });

/** Inspect the pinned package without loading its runtime or contacting Cursor. */
export async function getInstalledCursorVersion(): Promise<string | null> {
  try {
    const entry = import.meta.resolve("@cursor/sdk");
    const metadata = await readFile(new URL("../../package.json", entry), "utf8");
    return PackageVersionSchema.parse(JSON.parse(metadata)).version;
  } catch {
    return null;
  }
}
