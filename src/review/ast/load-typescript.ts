import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type tsType from "typescript";

let cachedTypescript: typeof tsType | undefined | null = null;

export function loadTypescript(): typeof tsType | undefined {
  if (cachedTypescript !== null) return cachedTypescript;

  try {
    const require = createRequire(import.meta.url);
    cachedTypescript = requireTypescript(require);
  } catch {
    try {
      const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
      cachedTypescript = requireTypescript(require);
    } catch {
      cachedTypescript = undefined;
    }
  }

  return cachedTypescript;
}

function requireTypescript(require: NodeJS.Require): typeof tsType {
  // SAFETY: Node resolves the installed `typescript` package whose export owns the imported type.
  return require("typescript") as typeof tsType;
}
