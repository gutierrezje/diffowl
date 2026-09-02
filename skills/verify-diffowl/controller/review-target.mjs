import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControllerError } from "./errors.mjs";
import { runCommand } from "./system.mjs";

export async function prepareReviewTarget({ featureId, scratch, surface }) {
  const kind = reviewTargetKind(featureId);
  const sourceDir = join(scratch, "src");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "verification-target.ts"),
    [
      "export function parsePositive(value: string): number {",
      "  const parsed = Number(value);",
      "  return parsed > 0 ? parsed : 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const staged = await runCommand("git", ["add", "src/verification-target.ts"], { cwd: scratch });
  if (staged.exitCode !== 0) throw targetPreparationError(featureId, staged.stderr);

  if (kind === "commit" || kind === "last-commit") {
    const committed = await commitTarget(scratch, `verify: ${surface} commit target`);
    if (committed.exitCode !== 0) throw targetPreparationError(featureId, committed.stderr);
  }
  if (kind === "base") {
    const switched = await runCommand("git", ["switch", "-c", `verify-${surface}-base`], {
      cwd: scratch,
    });
    if (switched.exitCode !== 0) throw targetPreparationError(featureId, switched.stderr);
    const committed = await commitTarget(scratch, `verify: ${surface} base target`);
    if (committed.exitCode !== 0) throw targetPreparationError(featureId, committed.stderr);
  }
  return {
    mutationRecords: [
      {
        kind: "git-fixture",
        path: "src/verification-target.ts",
        target: kind,
        authority: "disposable-repository-only",
      },
    ],
  };
}

export function reviewTargetArguments(featureId) {
  switch (reviewTargetKind(featureId)) {
    case "commit":
      return ["--commit", "HEAD"];
    case "base":
      return ["--base", "main"];
    case "staged":
      return ["--staged"];
    case "last-commit":
      return [];
    case "unknown":
      return [];
    default:
      throw new Error(`Unhandled review target for ${featureId}`);
  }
}

export function reviewTargetKind(featureId) {
  if (featureId.endsWith("-last-commit")) return "last-commit";
  if (featureId.endsWith("-commit")) return "commit";
  if (featureId.endsWith("-base")) return "base";
  if (
    featureId.endsWith("-staged") ||
    featureId.endsWith("-cancel") ||
    featureId.endsWith("-runtime-ready")
  ) {
    return "staged";
  }
  return "unknown";
}

function commitTarget(scratch, message) {
  return runCommand(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=DiffOwl Verify",
      "-c",
      "user.email=verify@diffowl.local",
      "commit",
      "-m",
      message,
    ],
    { cwd: scratch },
  );
}

function targetPreparationError(featureId, observed) {
  return new ControllerError({
    command: "run",
    expected: `a disposable Git target for ${featureId}`,
    observed,
    likelyCause: "The controller could not prepare the feature's exact review target.",
    nextAction: "Retain the scratch, inspect Git state, and retry with a fresh run ID.",
  });
}
