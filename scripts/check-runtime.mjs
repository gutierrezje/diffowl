const minimum = { major: 22, minor: 14, patch: 0 };

const current = {
  node: process.version,
  execPath: process.execPath,
};

function fail(lines) {
  console.error(["DiffOwl runtime check failed.", "", ...lines].join("\n"));
  process.exit(1);
}

function parseNodeVersion(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeastMinimum(version) {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

const parsed = parseNodeVersion(current.node);
if (!parsed || !isAtLeastMinimum(parsed)) {
  fail([
    `Expected Node >=${minimum.major}.${minimum.minor}.${minimum.patch}, but this command is running ${current.node}.`,
    `Node path: ${current.execPath}`,
    "",
    "Use a supported Node runtime:",
    "  nvm use",
  ]);
}

const emitWarning = process.emitWarning;
process.emitWarning = function suppressNodeSqliteExperimentalWarning(warning, ...args) {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (message?.includes("SQLite is an experimental feature")) {
    return;
  }
  emitWarning.call(process, warning, ...args);
};

try {
  const sqlite = await import("node:sqlite");
  if (typeof sqlite.DatabaseSync !== "function") {
    fail(["The active Node runtime does not expose node:sqlite DatabaseSync."]);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail([
    "The active Node runtime cannot load node:sqlite.",
    `Reason: ${message}`,
    `Node path: ${current.execPath}`,
  ]);
} finally {
  process.emitWarning = emitWarning;
}
