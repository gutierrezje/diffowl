import { ControllerError } from "./errors.mjs";

const valueFlags = new Set([
  "--run",
  "--run-id",
  "--model",
  "--reasoning",
  "--label",
  "--timeout-ms",
  "--interval-ms",
  "--ref",
]);
const booleanFlags = new Set(["--json", "--dry-run", "--follow"]);

export function parseArguments(args, command) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (booleanFlags.has(argument)) {
      options[argument.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (valueFlags.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new ControllerError({
          command,
          expected: `a value after ${argument}`,
          observed: value ?? "end of command",
          likelyCause: "A value-bearing option was incomplete.",
          nextAction: `Run the leaf help for ${command} and supply ${argument}.`,
          exitCode: 2,
        });
      }
      options[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new ControllerError({
        command,
        expected: "a documented option",
        observed: argument,
        likelyCause: "The option is not part of this controller interface.",
        nextAction: `Run the leaf help for ${command}.`,
        exitCode: 2,
      });
    }
    positionals.push(argument);
  }

  return { options, positionals };
}
