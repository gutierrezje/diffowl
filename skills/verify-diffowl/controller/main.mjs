#!/usr/bin/env node
import { getAdapter, listAdapters } from "./adapters/index.mjs";
import { executeSurfaceCommand } from "./commands.mjs";
import { ControllerError } from "./errors.mjs";
import { leafHelp, surfaceCommands, topLevelHelp } from "./help.mjs";
import { parseArguments } from "./options.mjs";
import { executeRun } from "./run-command.mjs";

const args = process.argv.slice(2);
const wantsJson = args.includes("--json");

try {
  await main(args);
} catch (error) {
  if (error instanceof ControllerError) {
    printFailure(error, wantsJson);
    process.exit(error.exitCode);
  }
  printFailure(
    new ControllerError({
      command: args[0] === "run" ? "run" : (args[1] ?? args[0] ?? "control-diffowl"),
      expected: "the controller command to complete",
      observed: error instanceof Error ? error.message : String(error),
      likelyCause: "An unexpected controller implementation error occurred.",
      nextAction: "Retain the run evidence and inspect the controller stack with a maintainer.",
    }),
    wantsJson,
  );
  process.exit(1);
}

async function main(commandLine) {
  if (commandLine.length === 0 || isHelp(commandLine[0])) {
    process.stdout.write(`${topLevelHelp()}\n`);
    return;
  }
  if (commandLine[0] === "run") {
    if (isHelp(commandLine[1])) {
      process.stdout.write(`${leafHelp("<surface>", "run")}\n`);
      return;
    }
    const { options, positionals } = parseArguments(commandLine.slice(1), "run");
    const adapter = getAdapter(positionals[0]);
    if (!adapter) {
      throw new ControllerError({
        command: "run",
        expected: "surface cli, codex, or opencode",
        observed: positionals[0] ?? "missing surface",
        likelyCause: "The feature run did not identify a supported surface.",
        nextAction: "Run control-diffowl --help.",
        exitCode: 2,
      });
    }
    const result = await executeRun({ adapter, featureId: positionals[1], options });
    printResult(result, Boolean(options.json));
    if (!result.success && !result.dryRun) process.exitCode = 1;
    return;
  }

  const adapter = getAdapter(commandLine[0]);
  if (!adapter) {
    throw new ControllerError({
      command: commandLine[0] ?? "control-diffowl",
      expected: `one of ${listAdapters()
        .map(({ surface }) => surface)
        .join(", ")}, or run`,
      observed: commandLine[0] ?? "missing command",
      likelyCause: "The requested surface or command is not part of the controller interface.",
      nextAction: "Run control-diffowl --help or a surface capabilities command.",
      exitCode: 2,
    });
  }

  const command = commandLine[1];
  if (!command || isHelp(command)) {
    process.stdout.write(`${surfaceHelp(adapter)}\n`);
    return;
  }
  if (isHelp(commandLine[2])) {
    process.stdout.write(`${leafHelp(adapter.surface, command)}\n`);
    return;
  }
  const { options, positionals } = parseArguments(commandLine.slice(2), command);
  if (command === "capabilities") {
    printResult(capabilities(adapter), Boolean(options.json));
    return;
  }
  if (!surfaceCommands.includes(command)) {
    throw new ControllerError({
      command,
      expected: `one of ${surfaceCommands.join(", ")}`,
      observed: command,
      likelyCause: "The command is not part of this surface interface.",
      nextAction: `Run control-diffowl ${adapter.surface} capabilities --json.`,
      exitCode: 2,
    });
  }
  const result = await executeSurfaceCommand({ adapter, command, options, positionals });
  printResult(result, Boolean(options.json));
  if (!result.success) {
    process.exitCode = 1;
  }
}

function capabilities(adapter) {
  return {
    schemaVersion: 1,
    command: "capabilities",
    success: true,
    surface: adapter.surface,
    observedTarget: null,
    artifacts: [],
    cleanup: { removed: [], restored: [], retained: [], running: [] },
    commands: [...surfaceCommands, "run"],
    features: adapter.features,
    entryPoints: adapter.entryPoints,
    human: `${adapter.surface}: ${adapter.description}\n\nCommands:\n${[...surfaceCommands, "run"]
      .map((name) => `  ${name}`)
      .join("\n")}\n\nFeatures:\n${adapter.features.map((id) => `  ${id}`).join("\n")}`,
  };
}

function printResult(result, json) {
  if (Array.isArray(result.jsonLines)) {
    for (const event of result.jsonLines) process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (json) {
    const serializable = { ...result };
    delete serializable.scalar;
    delete serializable.human;
    process.stdout.write(`${JSON.stringify(serializable)}\n`);
    return;
  }
  if (result.scalar !== undefined) {
    process.stdout.write(`${result.scalar}\n`);
    return;
  }
  if (result.human !== undefined) {
    process.stdout.write(`${result.human}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printFailure(error, json) {
  const result = {
    schemaVersion: 1,
    command: error.command,
    success: false,
    observedTarget: null,
    artifacts: [],
    cleanup: { removed: [], restored: [], retained: [], running: [] },
    error: error.details,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stderr.write(
    `Expected: ${error.details.expected}\nObserved: ${error.details.observed}\nLikely cause: ${error.details.likelyCause}\nNext action: ${error.details.nextAction}\n`,
  );
}

function surfaceHelp(adapter) {
  return `Usage: control-diffowl ${adapter.surface} <command> [options]

${adapter.description}

Commands:
${surfaceCommands.map((name) => `  ${name}`).join("\n")}

Run control-diffowl ${adapter.surface} <command> --help for leaf-command details.`;
}

function isHelp(value) {
  return value === "--help" || value === "-h";
}
