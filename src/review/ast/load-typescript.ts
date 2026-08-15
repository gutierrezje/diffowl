import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type tsType from "typescript";

let cachedTypescript: typeof tsType | undefined | null = null;

export function loadTypescript(): typeof tsType | undefined {
  if (cachedTypescript !== null) return cachedTypescript;

  try {
    const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
    cachedTypescript = require("typescript") as typeof tsType;
  } catch {
    try {
      const require = createRequire(import.meta.url);
      cachedTypescript = require("typescript") as typeof tsType;
    } catch {
      cachedTypescript = undefined;
    }
  }

  return cachedTypescript;
}
