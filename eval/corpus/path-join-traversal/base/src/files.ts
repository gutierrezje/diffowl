import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "/srv/app/uploads";

export async function readUserUpload(name: string): Promise<string> {
  return readFile(join(ROOT, sanitizeName(name)), "utf8");
}

function sanitizeName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Upload name cannot traverse directories.");
  }
  return segments.join("/");
}
