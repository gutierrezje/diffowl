import { createRequire } from "node:module";
import { join } from "node:path";

const expectedMajor = 22;
const expectedAbi = "127";

const current = {
  node: process.version,
  abi: process.versions.modules,
  execPath: process.execPath,
};

function fail(lines) {
  console.error(["DiffOwl native runtime check failed.", "", ...lines].join("\n"));
  process.exit(1);
}

if (!current.node.startsWith(`v${expectedMajor}.`)) {
  fail([
    `Expected Node ${expectedMajor}.x, but this command is running ${current.node}.`,
    `Node path: ${current.execPath}`,
    "",
    "Use the pinned project runtime, then rebuild native dependencies:",
    "  nvm use",
    "  pnpm rebuild better-sqlite3",
  ]);
}

if (current.abi !== expectedAbi) {
  fail([
    `Expected NODE_MODULE_VERSION ${expectedAbi}, but this command is running ${current.abi}.`,
    `Node path: ${current.execPath}`,
    "",
    "Use the pinned project runtime, then rebuild native dependencies:",
    "  nvm use",
    "  pnpm rebuild better-sqlite3",
  ]);
}

const requireFromProject = createRequire(join(process.cwd(), "package.json"));

try {
  const Database = requireFromProject("better-sqlite3");
  new Database(":memory:").close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("compiled against a different Node.js version")
  ) {
    fail([
      "better-sqlite3 was built for a different Node ABI.",
      `Active Node: ${current.node} (NODE_MODULE_VERSION ${current.abi})`,
      `Node path: ${current.execPath}`,
      "",
      "Rebuild it with the pinned project Node:",
      "  nvm use",
      "  pnpm rebuild better-sqlite3",
    ]);
  }

  throw error;
}
