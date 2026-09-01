#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  saveConfig,
  configExists,
  getDiffOwlDir,
  getProjectRoot,
  parseReviewContextDepth,
  type DiffOwlConfig,
  type ReviewContextDepth,
} from "./config.js";
import {
  loadEffectiveReviewConfig,
  MissingModelError,
  resolveReviewBackendPreference,
} from "./effective-config.js";
import {
  getReviewPreferencesPath,
  loadReviewPreferences,
  resetReviewBackendModel,
  resetReviewBackendPreference,
  resetReviewBackendReasoning,
  saveReviewBackendModel,
  saveReviewBackendPreference,
  saveReviewBackendReasoning,
} from "./review-preference.js";
import {
  formatReviewBackend,
  parseBackendModel,
  parseReviewBackend,
  type ReviewBackend,
  type ReviewSelection,
} from "./review/backend-selection.js";
import { parseReasoningVariant } from "./review/reasoning.js";
import {
  getAvailableModels,
} from "./opencode/client.js";
import { ReviewCancelledError } from "./review/errors.js";
import type { ReviewProgressEvent, ReviewTiming, ReviewUsage } from "./review/types.js";
import { getOpenCodeFailureGuidance } from "./opencode/guidance.js";
import { runEvalCommand } from "./eval/command.js";
import { canSelectModelInteractively, selectModel } from "./opencode/model-selection.js";
import {
  ensureServer,
  getInstalledOpencodeVersion,
  getServerHealth,
  stopServer,
} from "./opencode/server.js";
import {
  installHook,
  getHookCommand,
  uninstallHook,
  isHookInstalled,
  checkHookStale,
  checkRecentHookFailure,
  formatHookFailure,
  listPendingReviews,
  runHookReview,
  runHookWorker,
  releaseHookReviewLock,
  writeHookStatus,
} from "./git/hooks.js";
import { isGitRepo, hasCommits } from "./git/diff.js";
import {
  agentInstructionExists,
  defaultInstallHook,
  defaultWriteInstruction,
  detectAgentClients,
  enableAgentPath,
  parseYesNo,
  yesNoPromptSuffix,
  type AgentPathResult,
} from "./integrations/agent-path.js";
import { installClaudeCodeHook } from "./integrations/claude-code.js";
import { getSharedDiffOwlDir } from "./git/state-root.js";
import { printHeader, printFooter } from "./review/formatter.js";
import {
  getPersistedReview,
  loadFindingOccurrenceCounts,
  type PersistReviewRunResult,
} from "./state/persist.js";
import {
  buildReviewJsonDocument,
  parseReviewOutputFormat,
  reviewStatusFromPersisted,
  writeJsonError,
  writeReviewJsonSuccess,
  type BuildReviewJsonInput,
  type ReviewOutputFormat,
} from "./output/json.js";
import {
  formatFindingDetail,
  formatFindingList,
  formatFindingSummaryLine,
  formatPossibleDuplicateDetail,
  formatPossibleDuplicateList,
  renderFindingDetailJson,
  renderFindingListJson,
  renderFindingSummaryJson,
  renderPossibleDuplicateDetailJson,
  renderPossibleDuplicateListJson,
} from "./output/findings.js";
import { formatPendingReview, renderHookStatusJson } from "./output/hook-status.js";
import {
  deferFindingByLocator,
  dismissFindingByLocator,
  fixFindingByLocator,
  listUnresolvedFindings,
  LocatorAmbiguousError,
  LocatorNotFoundError,
  reopenFindingByLocator,
  requireFindingDetail,
  withFindingDatabase,
  withFindingDatabaseForRead,
} from "./state/findings-query.js";
import {
  EMPTY_FINDING_SUMMARY,
  getFindingSummary,
  hasReportableFindings,
  logSummaryDegradation,
  type FindingSummary,
} from "./state/findings-summary.js";
import { InvalidFindingTransitionError } from "./state/db.js";
import type { SqliteDatabase } from "./state/sqlite.js";
import type {
  FindingActor,
  PossibleDuplicateStatus,
  ReviewExecutionRecord,
} from "./state/types.js";
import {
  confirmPossibleDuplicate,
  getPossibleDuplicateDetailById,
  listPossibleDuplicates,
  rejectPossibleDuplicate,
} from "./state/possible-duplicates.js";
import { resolveCompletedReviewExit } from "./review/gate.js";
import { getReviewFailureExecution, runReviewPipeline } from "./review/run.js";
import { createSelectedReviewExecutor } from "./review/executor.js";
import {
  createSingleReviewAssignment,
} from "./review/provenance.js";
import type { ReviewTarget } from "./review/target.js";
import { inspectReviewRuntimes } from "./review/runtime.js";
import { getReviewBackendFailureGuidance } from "./review/guidance.js";

import { execa } from "execa";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

const program = new Command();
const REVIEW_INTERRUPT_FORCE_EXIT_MS = 30_000;
const NodeRuntimeDescriptionSchema = z.object({
  version: z.string(),
  modules: z.string(),
});
const CliErrorSchema = z.preprocess(
  (value) => (value instanceof Error ? value : new Error(String(value))),
  z.instanceof(Error),
);

type ReviewCommandOptions = {
  staged: boolean;
  commit?: string;
  base?: string | true;
  hook: boolean;
  failOnFindings: boolean;
  depth?: string;
  reasoning?: string;
  model?: string;
  backend?: string;
  verbose: boolean;
  format: string;
};

program
  .name("diffowl")
  .description("Local AI code review agent")
  .version(packageJson.version);

// Default command: review last commit
program
  .command("review", { isDefault: true })
  .description("Review the last commit, staged changes, or committed branch changes")
  .option("--staged", "Review staged changes instead of last commit")
  .option("--commit <ref>", "Review a specific commit ref instead of HEAD")
  .option("--base [ref]", "Review committed branch changes since the merge base")
  .option("--hook", "Running from git hook (non-blocking mode)")
  .option("--fail-on-findings", "Exit 1 when the review status is open")
  .option("--depth <depth>", "Review context depth: shallow or default")
  .option("--reasoning <variant>", "Backend-native reasoning variant")
  .option("--model <id>", "Review model override")
  .option("--backend <backend>", "Review backend override: opencode or codex")
  .option("--verbose", "Include suppressed findings and extra review details")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (options: ReviewCommandOptions) => {
    const format = resolveReviewOutputFormat(options.format);
    const jsonMode = format === "json";
    const commitRef = options.commit;
    const commitRequested = commitRef !== undefined;
    const hookCommit = options.hook && commitRequested ? commitRef : undefined;
    const hookLock = options.hook ? process.env["DIFFOWL_HOOK_LOCK"] : undefined;
    if (hookLock) {
      process.once("exit", () => releaseHookReviewLock(hookLock));
    }

    if (options.hook) {
      await writeHookStatus(0, hookCommit, "Review started.");
    }

    const totalStart = performance.now();
    const timings: ReviewTiming[] = [];

    // Preflight checks
    const gitRepoStart = performance.now();
    const isRepo = await isGitRepo();
    timings.push(createCliTiming("git-repo-check", "Git repository check", gitRepoStart));
    if (!isRepo) {
      await failReview(format, "Not a git repository", { hook: options.hook, hookCommit });
    }

    // First run: prompt for setup
    if (!configExists()) {
      console.log(chalk.yellow("No .diffowl.yml found. Running first-time setup...\n"));
      await runInit();
    }

    const reviewOverrides: Parameters<typeof loadEffectiveReviewConfigOrExit>[0] = {};
    if (options.backend !== undefined) {
      reviewOverrides.backend = options.backend;
    }
    if (options.model !== undefined) {
      reviewOverrides.model = options.model;
    }
    if (options.reasoning !== undefined) {
      reviewOverrides.reasoning = options.reasoning;
    }
    const effective = await loadEffectiveReviewConfigOrExit(reviewOverrides, format);
    const { config, selection } = effective;
    const reviewWarnings = [...effective.warnings];
    const projectRoot = getProjectRoot();
    const diffOwlDir = await getSharedDiffOwlDir();
    const baseRequested = options.base !== undefined;
    if (options.staged && commitRequested) {
      await failReview(format, "Cannot use --staged and --commit together", {
        hook: options.hook,
        hookCommit,
      });
    }
    if (options.staged && baseRequested) {
      await failReview(format, "Cannot use --staged and --base together", {
        hook: options.hook,
        hookCommit,
      });
    }
    if (commitRequested && baseRequested) {
      await failReview(format, "Cannot use --commit and --base together", {
        hook: options.hook,
        hookCommit,
      });
    }

    let target: ReviewTarget;
    if (options.staged) {
      target = { kind: "staged" };
    } else if (commitRequested) {
      target = { kind: "commit", ref: commitRef };
    } else if (options.base !== undefined) {
      target = { kind: "base" };
      if (options.base !== true) {
        target.ref = options.base;
      }
    } else {
      target = { kind: "last-commit" };
    }
    const depth = resolveReviewDepth(options.depth, config);
    const verbose = Boolean(config.verbose || options.verbose);

    if (target.kind !== "staged") {
      const hasCommitsStart = performance.now();
      const commitsExist = await hasCommits();
      timings.push(createCliTiming("git-commit-check", "Git commit check", hasCommitsStart));
      if (!commitsExist) {
        await failReview(format, "No commits found in this repository", {
          hook: options.hook,
          hookCommit,
        });
      }
    }

    if (!jsonMode) {
      printHeader();
      for (const warning of reviewWarnings) {
        console.warn(chalk.yellow(`⚠ ${warning}`));
      }
      if (reviewWarnings.length > 0) console.log();
    }

    const hookFailure = await checkRecentHookFailure();
    if (hookFailure && !jsonMode) {
      console.log(chalk.yellow(`⚠ ${formatHookFailure(hookFailure)}`));
      console.log();
    }

    const spinner = jsonMode
      ? null
      : ora({
          text: "Building local review context...",
          color: "cyan",
          discardStdin: false,
        }).start();
    const cancelController = new AbortController();
    let interruptExitCode: number | undefined;
    let interruptForceExit: ReturnType<typeof setTimeout> | undefined;
    let interruptMessage: string | undefined;
    // Register signal handlers immediately after spinner starts so they
    // cover the entire review lifecycle (context build, server connect, SSE).
    // discardStdin: false above ensures the terminal delivers SIGINT natively
    // instead of routing through stdin-discarder's raw-mode byte conversion.
    process.once("SIGINT", () => {
      interruptExitCode = 130;
      interruptMessage = "Review cancelled by user (Ctrl+C).";
      interruptForceExit = handleReviewInterrupt({
        cancelController,
        spinner,
        jsonMode,
        message: interruptMessage,
        forceExitCode: options.hook ? 0 : interruptExitCode,
      });
    });
    process.once("SIGTSTP", () => {
      interruptExitCode = 146;
      interruptMessage = "Review cancelled by user (Ctrl+Z).";
      interruptForceExit = handleReviewInterrupt({
        cancelController,
        spinner,
        jsonMode,
        message: interruptMessage,
        forceExitCode: options.hook ? 0 : interruptExitCode,
      });
    });

    try {
      const outcome = await runReviewPipeline({
        target,
        config,
        depth,
        verbose,
        projectRoot,
        diffOwlDir,
        timings,
        persistEmptyDiff: jsonMode,
        initialDiagnostics: effective.warnings,
        signal: cancelController.signal,
        executor: createSelectedReviewExecutor(
          createSingleReviewAssignment(selection, config.reasoning),
        ),
        onProgress: (event) => {
          if (spinner) {
            spinner.text = formatReviewProgress(event);
          }
        },
        onDiagnostics: (diagnostics) => {
          if (!spinner) {
            return;
          }
          spinner.warn("Local review context built with warnings.");
          for (const diagnostic of diagnostics) {
            console.log(chalk.yellow(`  - ${diagnostic}`));
          }
          console.log();
          spinner.start(`Connecting to ${formatReviewBackend(selection.backend)}...`);
        },
        onStatus: (message) => {
          if (spinner) {
            spinner.text = message;
          }
        },
        onWarning: (message) => {
          reviewWarnings.push(message);
          if (spinner) {
            const status = spinner.text;
            spinner.warn(message);
            spinner.start(status);
          }
        },
      });
      if (interruptForceExit !== undefined) clearTimeout(interruptForceExit);

      if (outcome.kind === "empty-diff") {
        spinner?.stop();
        printReviewExecutionDetails(selection, null, jsonMode);
        console.log(chalk.yellow("No changes to review"));
        if (options.hook) {
          await writeHookStatus(0, hookCommit);
        }
        process.exit(0);
      }

      if (outcome.kind === "skipped" && outcome.reason === "empty-diff") {
        spinner?.stop();
        await emitReviewJsonSuccess({
          diffOwlDir,
          reviewId: outcome.persisted.reviewId,
          persisted: outcome.persisted,
          suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
          verbose,
          timings: outcome.timings,
          selection,
          effectiveModel: null,
        });
        if (options.hook) {
          await writeHookStatus(0, hookCommit);
        }
        process.exit(0);
      }

      if (outcome.kind === "skipped" && outcome.reason === "documentation-only") {
        spinner?.stop();
        printReviewExecutionDetails(selection, null, jsonMode);
        if (!jsonMode) {
          console.warn(chalk.yellow("Documentation-only changes detected. Skipping review."));
        }
        if (jsonMode) {
          await emitReviewJsonSuccess({
            diffOwlDir,
            reviewId: outcome.persisted.reviewId,
            persisted: outcome.persisted,
            suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
            verbose,
            timings: outcome.timings,
            selection,
            effectiveModel: null,
          });
        } else {
          console.log(chalk.dim(`Report saved: ${outcome.reportPath}`));
        }
        if (options.hook) {
          await writeHookStatus(0, hookCommit);
        }
        process.exit(0);
      }

      if (outcome.kind !== "completed") {
        process.exit(0);
      }
      const report = outcome.report;
      spinner?.succeed("Review complete.");
      if (!jsonMode) {
        console.log(); // Space after spinner
      }
      const outputTimings = [
        ...outcome.timings,
        createCliTiming("total", "Total review command", totalStart),
      ];
      printReviewExecutionDetails(selection, outcome.effectiveModel, jsonMode);

      if (jsonMode) {
        await emitReviewJsonSuccess({
          diffOwlDir,
          reviewId: outcome.persisted.reviewId,
          persisted: outcome.persisted,
          suppressed: outcome.suppressed,
          verbose,
          timings: outputTimings,
          usage: outcome.usage,
          selection,
          effectiveModel: outcome.effectiveModel,
          execution: outcome.execution,
        });
      } else {
        printFooter(report, outcome.reportPath);
        printExecutionTelemetrySummary(outcome.execution);
        printTimingSummary(outputTimings);
      }
      const status = reviewStatusFromPersisted(
        { skippedReason: null },
        outcome.persisted,
      );
      const { exitCode, announceFailure } = resolveCompletedReviewExit({
        status,
        cliFlag: Boolean(options.failOnFindings),
        configEnabled: config.gate.fail_on_findings,
        hook: Boolean(options.hook),
        jsonMode,
      });
      if (options.hook) {
        await writeHookStatus(0, hookCommit);
      }
      if (announceFailure) {
        console.error(chalk.red("Review gate failed: open findings remain."));
      }
      process.exit(exitCode);
    } catch (err) {
      if (interruptForceExit !== undefined) clearTimeout(interruptForceExit);
      spinner?.stop();
      if (cancelController.signal.aborted || err instanceof ReviewCancelledError) {
        const message = appendReviewWarnings(
          interruptMessage ?? "Review cancelled by user.",
          reviewWarnings,
        );
        if (jsonMode) {
          writeJsonError(message, getReviewFailureExecution(err));
        } else if (!cancelController.signal.aborted) {
          console.log(chalk.yellow(`\n${message}`));
        }
        if (options.hook) {
          await writeHookStatus(1, hookCommit, message);
          process.exit(0);
        }
        if (!cancelController.signal.aborted) {
          process.exit(130);
        }
        process.exitCode = interruptExitCode ?? 130;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const backendName = formatReviewBackend(selection.backend);
      const guidance = getReviewBackendFailureGuidance(selection.backend, err);
      const failureMessage = `${backendName} review failed: ${message}`;
      if (jsonMode) {
        writeJsonError(
          appendReviewWarnings(
            guidance.length === 0
              ? failureMessage
              : `${failureMessage} Next action: ${guidance.join(" ")}`,
            reviewWarnings,
          ),
          getReviewFailureExecution(err),
        );
      } else {
        console.error(chalk.red(`\n${failureMessage}`));
        for (const line of guidance) {
          console.log(chalk.dim(line));
        }
      }
      if (options.hook) {
        await writeHookStatus(1, hookCommit, failureMessage);
        process.exit(0);
      }
      process.exit(1);
    }
  });

function formatReviewProgress(event: ReviewProgressEvent): string {
  switch (event.type) {
    case "server":
    case "session":
    case "idle":
      return event.message;
    case "tool":
      return `OpenCode tool: ${event.message}`;
    case "output":
      return event.message;
    case "timing":
      return event.message;
  }
}

async function describeNodeRuntime(node: string): Promise<string> {
  try {
    const { stdout } = await execa(node, [
      "-p",
      "JSON.stringify({ version: process.version, modules: process.versions.modules })",
    ]);
    const parsed = NodeRuntimeDescriptionSchema.safeParse(JSON.parse(stdout));
    if (parsed.success) {
      return `${node} (${parsed.data.version}, ABI ${parsed.data.modules})`;
    }
  } catch {}
  return node;
}

function resolveReviewDepth(
  value: Parameters<typeof parseReviewContextDepth>[0],
  config: DiffOwlConfig,
): ReviewContextDepth {
  if (value === undefined) {
    return config.context.depth;
  }

  try {
    return parseReviewContextDepth(value);
  } catch {
    console.error(chalk.red(`Invalid review depth: ${String(value)}`));
    console.error(chalk.dim("Expected one of: shallow, default"));
    process.exit(1);
  }
}

function createCliTiming(phase: string, label: string, start: number): ReviewTiming {
  return { phase, label, ms: Math.max(0, Math.round(performance.now() - start)) };
}

function printTimingSummary(timings: ReviewTiming[]): void {
  if (timings.length === 0) return;

  const ordered = [
    ...timings.filter((timing) => timing.phase !== "total"),
    ...timings.filter((timing) => timing.phase === "total"),
  ];

  console.log(chalk.dim("Timing:"));
  for (const timing of ordered) {
    console.log(chalk.dim(`  ${timing.label}: ${formatDuration(timing.ms)}`));
  }
  console.log();
}

function printExecutionTelemetrySummary(execution: ReviewExecutionRecord | null): void {
  const telemetry = execution?.telemetry;
  if (telemetry === null || telemetry === undefined || telemetry.transitions.length === 0) return;
  const slowest = telemetry.transitions.reduce((current, candidate) =>
    candidate.durationMs > current.durationMs ? candidate : current,
  );
  console.log(
    chalk.dim(
      `Slowest execution phase: ${slowest.phase.replaceAll("-", " ")} (${formatDuration(slowest.durationMs)}).`,
    ),
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Init command
program
  .command("init")
  .description("Set up DiffOwl for this project")
  .action(async () => {
    await runInit();
  });

async function runInit() {
  console.log(chalk.bold("DiffOwl Setup\n"));
  const config = await loadProjectConfigOrExit();
  const preferences = await loadReviewPreferencesOrExit();
  const { backend, source } = resolveReviewBackendPreference(preferences);
  const currentModel = preferences.models.find((selection) => selection.backend === backend)?.model;
  console.log(`${chalk.bold("Review backend:")} ${formatReviewBackend(backend)} (${source})`);
  console.log(chalk.dim(`Local preference: ${await getReviewPreferencesPath()}`));
  const modelOptions: Parameters<typeof selectModelInteractively>[1] = {
    allowKeepCurrent: false,
    backend,
  };
  if (currentModel !== undefined) {
    modelOptions.currentModel = currentModel;
  }
  await selectModelInteractively(config, modelOptions);
  console.log(chalk.green(`✓ Config saved to ${await saveConfig(config)}`));
  await enableAgentPathFromCli();
}

async function enableAgentPathFromCli(): Promise<void> {
  const projectRoot = getProjectRoot();
  if (!canSelectModelInteractively(process.stdin.isTTY, process.stdout.isTTY)) {
    console.log(chalk.dim("Skipped setup prompts (no terminal)."));
    console.log(
      chalk.dim(
        "Later: add AGENTS.md, `diffowl agent-hook install --client claude`, or `diffowl hook install`.",
      ),
    );
    return;
  }

  const clients = detectAgentClients({ projectRoot, env: process.env });
  const writeDefault = defaultWriteInstruction(agentInstructionExists(projectRoot));
  const hookDefault = defaultInstallHook(clients.claude);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log();
    const writeInstruction = await promptYesNo(
      rl,
      `Add DiffOwl instructions to AGENTS.md? ${yesNoPromptSuffix(writeDefault)} `,
      writeDefault,
    );
    const installClaudeHook = await promptYesNo(
      rl,
      `Install Claude Code session-start findings hook? ${yesNoPromptSuffix(hookDefault)} `,
      hookDefault,
    );
    const inGitRepo = await isGitRepo();
    const postCommitDefault = inGitRepo ? await isHookInstalled() : false;
    const installPostCommitHook = inGitRepo
      ? await promptYesNo(
          rl,
          `Install post-commit hook (review each commit in the background)? ${yesNoPromptSuffix(postCommitDefault)} `,
          postCommitDefault,
        )
      : false;
    printAgentPathResult(
      await enableAgentPath({
        projectRoot,
        env: process.env,
        writeInstruction,
        installHook: installClaudeHook,
      }),
    );
    if (installPostCommitHook) {
      await installPostCommitHookFromCli();
    } else if (inGitRepo) {
      console.log(chalk.dim("Skipped post-commit hook."));
    } else {
      console.log(chalk.dim("Skipped post-commit hook (not a git repository)."));
    }
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    rl.close();
  }
}

async function promptYesNo(
  rl: { question: (query: string) => Promise<string> },
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  while (true) {
    const choice = parseYesNo(await rl.question(chalk.yellow(prompt)), defaultYes);
    switch (choice.kind) {
      case "yes":
        return true;
      case "no":
        return false;
      case "invalid":
        console.log(chalk.red("Please answer y or n."));
        break;
      default: {
        const _exhaustive: never = choice;
        return _exhaustive;
      }
    }
  }
}

async function installPostCommitHookFromCli(): Promise<void> {
  const alreadyInstalled = await isHookInstalled();
  const hookPath = await installHook();
  const command = await getHookCommand();
  const action = alreadyInstalled ? "updated" : "installed";
  console.log(chalk.green(`✓ Post-commit hook ${action}: ${hookPath}`));
  console.log(chalk.dim(`Hook Node: ${await describeNodeRuntime(command.node)}`));
  console.log(chalk.dim(`Hook Entrypoint: ${command.cli}`));
  console.log(chalk.dim("Reviews will run automatically after each commit (non-blocking)"));
  console.log(chalk.dim("Hook output: .diffowl/hook.log; reports: .diffowl/reviews/"));
}

function printAgentPathResult(result: AgentPathResult): void {
  switch (result.instruction.kind) {
    case "created":
      console.log(chalk.green(`✓ Agent instructions written to ${result.instruction.path}`));
      break;
    case "updated":
      console.log(chalk.green(`✓ Agent instructions updated in ${result.instruction.path}`));
      break;
    case "skipped":
      console.log(chalk.dim("Skipped AGENTS.md instructions."));
      break;
    default: {
      const _exhaustive: never = result.instruction;
      return _exhaustive;
    }
  }

  switch (result.hook.kind) {
    case "claude":
      console.log(chalk.green(`✓ Claude Code session hook ${result.hook.action}`));
      console.log(chalk.dim(`Settings: ${result.hook.settingsPath}`));
      return;
    case "skipped":
      console.log(chalk.dim("Skipped Claude session hook."));
      return;
    default: {
      const _exhaustive: never = result.hook;
      return _exhaustive;
    }
  }
}

// Backend command
program
  .command("backend")
  .description("View or change the local review backend")
  .argument("[backend]", "Review backend: opencode or codex")
  .option("--reset", "Use the backward-compatible OpenCode default")
  .action(async (backendValue: string | undefined, options: { reset?: boolean }) => {
    if (backendValue && options.reset) {
      console.error(chalk.red("Cannot pass a backend and --reset together"));
      process.exit(1);
    }
    if (options.reset) {
      try {
        await resetReviewBackendPreference();
      } catch (error) {
        failConfigError(CliErrorSchema.parse(error));
      }
      console.log(chalk.green("✓ Backend preference reset to OpenCode default"));
      console.log(chalk.dim(`Local preference: ${await getReviewPreferencesPath()}`));
      return;
    }
    if (backendValue !== undefined) {
      let backend: ReviewBackend;
      try {
        backend = parseReviewBackend(backendValue);
      } catch {
        console.error(chalk.red(`Invalid backend: ${backendValue}`));
        console.error(chalk.dim("Expected one of: opencode, codex"));
        process.exit(1);
      }
      let path: string;
      try {
        path = await saveReviewBackendPreference(backend);
      } catch (error) {
        failConfigError(CliErrorSchema.parse(error));
      }
      console.log(chalk.green(`✓ Backend set to ${formatReviewBackend(backend)}`));
      console.log(chalk.dim(`Local preference: ${path}`));
      return;
    }

    const preferences = await loadReviewPreferencesOrExit();
    const { backend, source } = resolveReviewBackendPreference(preferences);
    const model = preferences.models.find((selection) => selection.backend === backend)?.model;
    const runtimes = await inspectReviewRuntimes();
    console.log(`${chalk.bold("Current backend:")} ${formatReviewBackend(backend)}`);
    console.log(`Preference source: ${source}`);
    console.log(`Model: ${model ?? "not selected"}`);
    for (const runtimeBackend of ["opencode", "codex"] as const) {
      const runtime = runtimes[runtimeBackend];
      console.log(
        `${formatReviewBackend(runtimeBackend)} runtime: ${
          runtime.available ? `available (${runtime.version})` : "not installed"
        }`,
      );
    }
    console.log(chalk.dim(`Local preference: ${await getReviewPreferencesPath()}`));
  });

// Model command
program
  .command("model")
  .description("View or change the model for the selected backend")
  .argument("[model]", "Backend-specific model id")
  .option("--reset", "Remove the selected backend's local model preference")
  .action(async (model: string | undefined, options: { reset?: boolean }) => {
    if (model && options.reset) {
      console.error(chalk.red("Cannot pass a model and --reset together"));
      process.exit(1);
    }
    const preferences = await loadReviewPreferencesOrExit();
    const { backend } = resolveReviewBackendPreference(preferences);
    if (options.reset) {
      await resetReviewBackendModel(backend);
      console.log(
        chalk.green(
          backend === "opencode"
            ? "✓ Local model preference reset (OpenCode)"
            : "✓ Codex model preference reset",
        ),
      );
      console.log(chalk.dim("Run `diffowl model <model-id>` to choose another."));
      return;
    }

    if (model !== undefined) {
      let parsedModel: string;
      try {
        parsedModel = parseBackendModel(backend, model);
      } catch {
        const detail =
          backend === "opencode"
            ? "OpenCode model must use provider/model format"
            : "Codex model must be a bare model id";
        console.error(chalk.red(`Invalid model for ${formatReviewBackend(backend)}: ${detail}`));
        process.exit(1);
      }

      const configPath = await saveReviewBackendModel(backend, parsedModel);
      console.log(
        chalk.green(
          backend === "opencode"
            ? `✓ Model set to ${chalk.cyan(parsedModel)} (OpenCode)`
            : `✓ Codex model set to ${chalk.cyan(parsedModel)}`,
        ),
      );
      console.log(chalk.dim(`Local preference: ${configPath}`));
      return;
    }

    let effective;
    try {
      effective = await loadEffectiveReviewConfig();
    } catch (err) {
      if (!(err instanceof MissingModelError)) {
        console.error(
          chalk.red(`Config error: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
      const config = await loadProjectConfigOrExit();
      console.log(chalk.yellow(`No ${formatReviewBackend(backend)} model selected.`));
      await selectModelInteractively(config, {
        allowKeepCurrent: false,
        backend,
      });
      return;
    }
    const config = effective.config;

    console.log(formatEffectiveModel(effective.selection));
    await selectModelInteractively(config, {
      allowKeepCurrent: true,
      backend,
      currentModel: effective.selection.requestedModel,
    });
  });

program
  .command("reasoning")
  .description("View or change reasoning for the selected backend model")
  .argument("[variant]", "Backend-native reasoning variant")
  .option("--reset", "Use the backend default for the selected model")
  .action(async (variant: string | undefined, options: { reset?: boolean }) => {
    if (variant !== undefined && options.reset) {
      console.error(chalk.red("Cannot pass a reasoning variant and --reset together"));
      process.exit(1);
    }

    const preferences = await loadReviewPreferencesOrExit();
    const { backend } = resolveReviewBackendPreference(preferences);
    const normalizedVariant = variant?.trim();
    if (options.reset) {
      await resetReviewBackendReasoning(backend);
      console.log(chalk.green("✓ Reasoning preference reset to backend default"));
      console.log(chalk.dim(`Backend: ${formatReviewBackend(backend)}`));
      return;
    }

    if (normalizedVariant !== undefined) {
      try {
        const parsedVariant = parseReasoningVariant(normalizedVariant);
        const configPath = await saveReviewBackendReasoning(backend, parsedVariant);
        console.log(chalk.green(`✓ Reasoning variant set to ${chalk.cyan(parsedVariant)}`));
        console.log(chalk.dim(`Backend: ${formatReviewBackend(backend)}`));
        console.log(chalk.dim(`Local preference: ${configPath}`));
      } catch (error) {
        failConfigError(CliErrorSchema.parse(error));
      }
      return;
    }

    const selection = preferences.models.find((candidate) => candidate.backend === backend);
    if (selection === undefined) {
      failConfigError(new MissingModelError(backend));
    }
    const selectedVariant =
      "reasoning" in selection ? selection.reasoning?.variant : undefined;
    console.log(
      `${chalk.bold("Reasoning variant:")} ${chalk.cyan(
        selectedVariant ?? "backend default",
      )}`,
    );
    console.log(chalk.dim(`Backend: ${formatReviewBackend(backend)}`));
    console.log(chalk.dim(`Model: ${selection.model}`));
  });

async function selectModelInteractively(
  config: DiffOwlConfig,
  options: { allowKeepCurrent: boolean; backend: ReviewBackend; currentModel?: string },
): Promise<void> {
  if (options.backend === "codex") {
    await selectCodexModelInteractively(options);
    return;
  }

  const spinner = ora("Querying available models from OpenCode...").start();
  let models: string[] = [];
  try {
    models = await getAvailableModels(config.server.port, {
      autoStart: config.server.auto_start,
    });
    spinner.stop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(`Failed to query models: ${message}`);
    for (const line of getOpenCodeFailureGuidance(message)) {
      console.error(chalk.dim(line));
    }
    process.exit(1);
  }

  let selectedModel = options.currentModel ?? models[0] ?? "";

  if (models.length > 0) {
    if (!canSelectModelInteractively(process.stdin.isTTY, process.stdout.isTTY)) {
      console.error(
        chalk.red(
          "Interactive model selection requires a terminal. Pass a model explicitly, for example `diffowl model provider/model`.",
        ),
      );
      process.exit(1);
    }

    console.log(
      chalk.bold(
        options.allowKeepCurrent
          ? "\nAvailable models configured in OpenCode:"
          : "Available models configured in OpenCode:",
      ),
    );
    models.forEach((m, idx) => {
      console.log(`  ${chalk.cyan(idx + 1)}. ${m}`);
    });
    console.log();

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      while (true) {
        const promptText = options.allowKeepCurrent
          ? `Select a model number (1-${models.length}) or press Enter to keep current: `
          : `Select a model number (1-${models.length}) [default: 1]: `;

        const selection = selectModel(
          models,
          selectedModel,
          await rl.question(chalk.yellow(promptText)),
          options.allowKeepCurrent,
        );
        if (selection.type === "kept") break;
        if (selection.type === "selected") {
          selectedModel = selection.model;
          break;
        }
        console.log(chalk.red("Invalid selection. Please enter a valid number."));
      }
    } finally {
      rl.close();
    }
  } else {
    console.error(chalk.red("\nNo active/connected providers found in OpenCode."));
    console.error(chalk.dim("Run opencode to configure a provider, then retry."));
    process.exit(1);
  }

  // Only update/save if a new model was selected or config is being initialized
  if (selectedModel !== options.currentModel || !options.allowKeepCurrent) {
    await saveReviewBackendModel("opencode", selectedModel);
    console.log(chalk.green(`✓ OpenCode model set to ${chalk.cyan(selectedModel)}`));
    console.log();
  }
}

async function selectCodexModelInteractively(
  options: { allowKeepCurrent: boolean; currentModel?: string },
): Promise<void> {
  if (!canSelectModelInteractively(process.stdin.isTTY, process.stdout.isTTY)) {
    console.error(
      chalk.red(
        "Interactive Codex model selection requires a terminal. Pass a model explicitly, for example `diffowl model gpt-5.4`.",
      ),
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const suffix =
        options.allowKeepCurrent && options.currentModel
          ? ` or press Enter to keep ${options.currentModel}`
          : "";
      const raw = await rl.question(chalk.yellow(`Codex model id${suffix}: `));
      if (raw.trim() === "" && options.allowKeepCurrent && options.currentModel) return;
      try {
        const model = parseBackendModel("codex", raw);
        await saveReviewBackendModel("codex", model);
        console.log(chalk.green(`✓ Codex model set to ${chalk.cyan(model)}`));
        console.log();
        return;
      } catch {
        console.log(chalk.red("Invalid Codex model. Expected a bare model id, for example gpt-5.4."));
      }
    }
  } finally {
    rl.close();
  }
}

// Hook commands
const hookCmd = program.command("hook").description("Manage git hooks");

hookCmd
  .command("install")
  .description("Install post-commit hook (non-blocking review)")
  .action(async () => {
    if (!(await isGitRepo())) {
      console.error(chalk.red("Not a git repository"));
      process.exit(1);
    }

    await installPostCommitHookFromCli();
  });

hookCmd
  .command("status")
  .description("Check if the post-commit hook is installed and up to date")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (options: { format?: string }) => {
    const format = resolveReviewOutputFormat(options.format);
    const [status, pending] = await Promise.all([
      checkHookStale(),
      listPendingReviews(getDiffOwlDir()),
    ]);

    if (format === "json") {
      process.stdout.write(renderHookStatusJson(status, pending));
      return;
    }

    if (!status.installed) {
      console.log(chalk.yellow(`✗ ${status.reason ?? "Hook not installed"}`));
    } else if (status.stale) {
      console.log(chalk.yellow("⚠ Hook is installed but stale"));
      console.log(chalk.dim(`Reason: ${status.reason}`));
      console.log(chalk.dim("Run `diffowl hook install` to update it."));
    } else {
      console.log(chalk.green("✓ Hook is installed and up to date"));
    }

    for (const item of pending) {
      console.log(formatPendingReview(item));
    }
  });

hookCmd
  .command("uninstall")
  .description("Remove the post-commit hook")
  .action(async () => {
    if (await uninstallHook()) {
      console.log(chalk.green("✓ Hook removed"));
    } else {
      console.log(chalk.yellow("No diffowl hook found"));
    }
  });

program
  .command("hook-run", { hidden: true })
  .description("Spawn a non-blocking hook review")
  .action(async () => {
    await runHookReview();
  });

program
  .command("hook-worker", { hidden: true })
  .description("Process queued hook reviews")
  .action(async () => {
    const hookLock = process.env["DIFFOWL_HOOK_LOCK"];
    if (hookLock) {
      process.once("exit", () => releaseHookReviewLock(hookLock));
    }
    try {
      await runHookWorker();
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

// Agent client hooks. Distinct from the `hook` group above, which is the git post-commit hook.
const AGENT_HOOK_CLIENTS = ["claude"] as const;

const agentHookCmd = program.command("agent-hook").description("Manage agent client session hooks");

agentHookCmd
  .command("install")
  .description("Install the session-start findings hook for an agent client")
  .requiredOption("--client <client>", `Agent client: ${AGENT_HOOK_CLIENTS.join(", ")}`)
  .action(async (options: { client: string }) => {
    // Exhaustive local dispatch rather than a registry: one adapter does not yet prove a shared
    // contract, and the rejecting default keeps the supported set explicit (D-13, D-19).
    switch (options.client) {
      case "claude": {
        try {
          // Anchor to the project root, not the invocation directory: Claude loads
          // .claude/settings.json from the project root, so installing from a subdirectory would
          // otherwise write a hook that never runs. Same anchor the rest of the CLI uses.
          const result = await installClaudeCodeHook(getProjectRoot());
          console.log(chalk.green(`✓ Claude Code session hook ${result.action}`));
          console.log(chalk.dim("Client: claude"));
          console.log(chalk.dim(`Settings: ${result.settingsPath}`));
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        return;
      }
      default:
        console.error(chalk.red(`Unsupported client: ${options.client}`));
        console.error(chalk.dim(`Supported clients: ${AGENT_HOOK_CLIENTS.join(", ")}`));
        process.exit(1);
    }
  });

function collectEvalCaseIds(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .command("eval", { hidden: true })
  .description("Run measured review quality eval harness")
  .option("--corpus <dir>", "Corpus directory", "eval/corpus")
  .option("--case <id>", "Run specific case(s) only", collectEvalCaseIds, Array<string>())
  .option("--trials <n>", "Trials per case", "1")
  .option("--mode <mode>", "Run mode: diffowl, baseline, or both", "diffowl")
  .option("--model <id>", "Review model override")
  .option("--depth <depth>", "Review context depth: shallow or default")
  .option("--reasoning <effort>", "Reasoning effort override")
  .option("--min-confidence <level>", "Minimum finding confidence: low, medium, or high")
  .option("--out <dir>", "Output directory for eval results")
  .option("--gate <path>", "Gate thresholds JSON file")
  .option("--compare <path>", "Compare results against a baseline eval-results.json")
  .option("--fail-on-regression", "Exit 1 when --compare detects regressions")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (options) => {
    process.exit(await runEvalCommand(options));
  });

// Server commands
const serverCmd = program.command("server").description("Manage the OpenCode server");

serverCmd
  .command("start")
  .description("Start the OpenCode server")
  .action(async () => {
    const config = await loadConfigOrExit();
    const spinner = ora("Starting OpenCode server...").start();
    try {
      const url = await ensureServer(config.server.port);
      spinner.succeed(`Server running at ${url}`);
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

serverCmd
  .command("stop")
  .description("Stop the OpenCode server")
  .action(async () => {
    const config = await loadConfigOrExit();
    if (await stopServer(config.server.port)) {
      console.log(chalk.green("✓ Server stopped"));
    } else {
      console.log(chalk.yellow(`No OpenCode server found on port ${config.server.port}`));
    }
  });

serverCmd
  .command("status")
  .description("Check if the OpenCode server is running")
  .action(async () => {
    const config = await loadConfigOrExit();
    const health = await getServerHealth(config.server.port);
    if (!health?.healthy) {
      console.log(chalk.yellow(`✗ No server on port ${config.server.port}`));
      return;
    }

    console.log(chalk.green(`✓ Server running on port ${config.server.port}`));
    const cliVersion = await getInstalledOpencodeVersion();
    if (health.version) {
      console.log(`  Server version: ${health.version}`);
    }
    if (cliVersion) {
      console.log(`  CLI version: ${cliVersion}`);
    }
    if (health.version && cliVersion && health.version !== cliVersion) {
      console.log(
        chalk.yellow(
          "⚠ Version mismatch. Restart with: diffowl server stop && diffowl server start",
        ),
      );
    }
  });

// Findings commands
const findingsCmd = program.command("findings").description("Inspect and manage durable findings");

findingsCmd
  .command("list", { isDefault: true })
  .description("List unresolved findings")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (options: { format?: string }) => {
    await loadConfigOrExit();
    const format = resolveReviewOutputFormat(options.format);
    const items = await withFindingDatabase(await getSharedDiffOwlDir(), listUnresolvedFindings);
    if (format === "json") {
      process.stdout.write(renderFindingListJson(items));
      return;
    }
    if (items.length === 0) {
      console.log(chalk.green("No unresolved findings."));
      return;
    }
    console.log(formatFindingList(items));
  });

findingsCmd
  .command("summary")
  .description("Print an aggregate summary of unresolved findings (reachable from HEAD by default)")
  .option("--format <format>", "Output format: text or json", "text")
  .option("--all", "Also include findings from commits not reachable from HEAD")
  .action(async (options: { format?: string; all?: boolean }) => {
    const format = resolveReviewOutputFormat(options.format);
    containStdoutErrors();
    // Deliberately no loadConfigOrExit() here, unlike every sibling findings subcommand: this is
    // the command invoked automatically at session start, and exiting 1 on a missing/invalid
    // .diffowl.yml would break session start in any repo the user has not configured (D-17). This
    // command reads git and SQLite only; it needs no model and no config.
    try {
      const summary = await getFindingSummary(await getSharedDiffOwlDir(), {
        includeUnreachable: options.all === true,
      });
      writeFindingSummary(summary, format);
    } catch (error) {
      // getFindingSummary has its own fail-silent boundary, but it only covers what happens inside
      // it. This one covers the rest of the action — resolving the shared state directory (which
      // shells out to git, and throws on any git failure it does not recognise), rendering, and the
      // write itself — so that no path out of a session-start command is a non-zero exit.
      await reportSummaryFailure(error);
      // The published JSON contract stays total across this boundary too. getFindingSummary already
      // degrades every failure inside it to the zero-count summary, which the JSON projection duly
      // publishes, so the outer boundary must not be the single path that writes an empty buffer to
      // a consumer parsing stdout. Either way the reason is in hook.log, which is the only place
      // "0 findings" and "could not tell" are distinguishable — the same ambiguity the inner legs
      // already accept under D-17.
      //
      // Guarded, because this write is not obviously safer than the one that just failed: if the
      // try-block threw while rendering or writing, re-running the same write here would reject the
      // action and exit non-zero, which is the single outcome this whole boundary exists to
      // prevent. This catches synchronous failures only — the asynchronous ones are contained by
      // containStdoutErrors() above, which is what actually covers the EPIPE case.
      try {
        writeFindingSummary(EMPTY_FINDING_SUMMARY, format);
      } catch {
        // Both the report and its fallback are now unwritable. hook.log already has the reason.
      }
    }
  });

const duplicateCmd = findingsCmd
  .command("duplicates")
  .description("Review possible duplicate finding links");

duplicateCmd
  .command("show")
  .description("Show one possible duplicate link")
  .argument("<duplicate-id>", "Possible duplicate link id")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (duplicateId: string, options: { format?: string }) => {
    await loadConfigOrExit();
    const format = resolveReviewOutputFormat(options.format);
    try {
      const detail = await withFindingDatabaseForRead(await getSharedDiffOwlDir(), (db) => {
        const item = getPossibleDuplicateDetailById(db, duplicateId);
        if (!item) {
          throw new InvalidFindingTransitionError(`Possible duplicate ${duplicateId} was not found.`);
        }
        return item;
      });
      if (format === "json") {
        process.stdout.write(renderPossibleDuplicateDetailJson(detail));
        return;
      }
      console.log(formatPossibleDuplicateDetail(detail));
    } catch (err) {
      failFindingsCommand(format, CliErrorSchema.parse(err));
    }
  });

duplicateCmd
  .command("list")
  .description("List possible duplicate suggestions")
  .option("--status <status>", "Filter: suggested, confirmed, rejected, or expired")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (options: { status?: string; format?: string }) => {
    await loadConfigOrExit();
    const format = resolveReviewOutputFormat(options.format);
    const status = parsePossibleDuplicateStatus(options.status ?? "suggested", format);
    try {
      const items = await withFindingDatabaseForRead(await getSharedDiffOwlDir(), (db) =>
        listPossibleDuplicates(db, status),
      );
      if (format === "json") {
        process.stdout.write(renderPossibleDuplicateListJson(items));
      } else {
        console.log(formatPossibleDuplicateList(items));
      }
    } catch (err) {
      failFindingsCommand(format, CliErrorSchema.parse(err));
    }
  });

for (const decision of ["confirm", "reject"] as const) {
  duplicateCmd
    .command(decision)
    .description(`${decision === "confirm" ? "Confirm" : "Reject"} a possible duplicate link`)
    .argument("<duplicate-id>", "Possible duplicate link id")
    .requiredOption("--reason <text>", "Decision reason")
    .option("--actor <actor>", "Actor: user or agent", "user")
    .option("--format <format>", "Output format: text or json", "json")
    .action(async (duplicateId: string, options: { reason: string; actor?: string; format?: string }) => {
      await loadConfigOrExit();
      const format = resolveReviewOutputFormat(options.format);
      try {
        const updated = await withFindingDatabase(await getSharedDiffOwlDir(), (db) =>
          decision === "confirm"
            ? confirmPossibleDuplicate(db, duplicateId, { actor: parseFindingActor(options.actor), reason: options.reason })
            : rejectPossibleDuplicate(db, duplicateId, { actor: parseFindingActor(options.actor), reason: options.reason }),
        );
        if (format === "json") {
          process.stdout.write(renderPossibleDuplicateDetailJson(updated));
        } else {
          console.log(formatPossibleDuplicateDetail(updated));
        }
      } catch (err) {
        failFindingsCommand(format, CliErrorSchema.parse(err));
      }
    });
}

/**
 * The two projections of one getFindingSummary result (D-18). Neither recomputes counts,
 * reachability, or severity; both read the same value.
 *
 * The fail-silent contract from plan 01-05 is asymmetric across them on purpose. The text
 * projection is what a SessionStart hook injects verbatim, so with nothing to report it prints
 * nothing at all (D-11) — silence is the correct signal and costs zero context. The JSON
 * projection is read by a script or an MCP handler that parses stdout, so it always emits a
 * document, carrying zero counts and a null top severity when there is nothing to report; an empty
 * buffer there is a parse error, not "no findings".
 */
function writeFindingSummary(summary: FindingSummary, format: ReviewOutputFormat): void {
  if (format === "json") {
    process.stdout.write(renderFindingSummaryJson(summary));
    return;
  }
  if (!hasReportableFindings(summary)) {
    return;
  }
  console.log(formatFindingSummaryLine(summary));
}

/**
 * Contain stdout failures that a try/catch structurally cannot reach.
 *
 * When stdout is a pipe — which is the case for the SessionStart hook, and for the script and MCP
 * consumers `--format json` exists for — `process.stdout.write()` is asynchronous. If the consumer
 * closes the pipe, EPIPE arrives as an `'error'` event on the stream, not as a synchronous throw,
 * so wrapping the write in try/catch does nothing: with no listener the event becomes an uncaught
 * exception and the process still exits non-zero. Verified by hand against Node's default
 * behaviour, which reports "Unhandled 'error' event" and exits 1.
 *
 * A listener is therefore the only thing that contains it, and it must be attached before the
 * first write. Swallowing is the whole point: at this stage the summary has already been rendered
 * for a reader who is no longer there, so there is nothing left to deliver and nothing to salvage.
 *
 * Scoped to this command rather than installed globally. Every other command is one a user ran and
 * is watching, and a silently truncated stdout there would hide a real failure; D-17's
 * never-fail rule is specific to the automatic session-start path.
 */
function containStdoutErrors(): void {
  process.stdout.on("error", () => {
    // Deliberately total, not EPIPE-only. The contract this serves is "no path out of this command
    // is a non-zero exit", and narrowing it to one errno would leave the rest of the stream's error
    // surface — ERR_STREAM_DESTROYED, a closed fd — reaching the same uncaught handler by the same
    // route. Nothing is lost by swallowing: stdout is where a diagnostic would otherwise go.
  });
}

/** Never throws: its whole purpose is to be safe to call from the session-start path. */
async function reportSummaryFailure(
  error: Parameters<typeof logSummaryDegradation>[2],
): Promise<void> {
  try {
    // getDiffOwlDir() is the checkout-local path rather than the shared one, because the shared
    // lookup is itself a thing that can fail here. It also never creates anything, so an unwritable
    // or absent directory loses the line instead of leaving state behind in an unused repo.
    await logSummaryDegradation(getDiffOwlDir(), "findings summary could not run", error);
  } catch {
    // Nowhere left to report to. Silence is the contract.
  }
}

findingsCmd
  .command("show")
  .description("Show one finding by locator")
  .argument("<locator>", "Finding id, id prefix, or latest:N")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (locator: string, options: { format?: string }) => {
    await loadConfigOrExit();
    const format = resolveReviewOutputFormat(options.format);
    try {
      const detail = await withFindingDatabase(await getSharedDiffOwlDir(), (db) =>
        requireFindingDetail(db, locator),
      );
      if (format === "json") {
        process.stdout.write(renderFindingDetailJson(detail));
        return;
      }
      console.log(formatFindingDetail(detail));
    } catch (err) {
      failFindingsCommand(format, CliErrorSchema.parse(err));
    }
  });

findingsCmd
  .command("dismiss")
  .description("Dismiss a finding")
  .argument("<locator>", "Finding id, id prefix, or latest:N")
  .requiredOption("--reason <text>", "Dismissal reason")
  .option("--actor <actor>", "Actor: user or agent", "user")
  .option("--format <format>", "Output format: text or json", "json")
  .action(async (locator: string, options: { reason: string; actor?: string; format?: string }) => {
    await runFindingMutation(locator, options.format, (db) =>
      dismissFindingByLocator(db, locator, {
        actor: parseFindingActor(options.actor),
        reason: options.reason,
      }),
    );
  });

findingsCmd
  .command("defer")
  .description("Defer a finding")
  .argument("<locator>", "Finding id, id prefix, or latest:N")
  .requiredOption("--reason <text>", "Deferral reason")
  .option("--actor <actor>", "Actor: user or agent", "user")
  .option("--format <format>", "Output format: text or json", "json")
  .action(async (locator: string, options: { reason: string; actor?: string; format?: string }) => {
    await runFindingMutation(locator, options.format, (db) =>
      deferFindingByLocator(db, locator, {
        actor: parseFindingActor(options.actor),
        reason: options.reason,
      }),
    );
  });

findingsCmd
  .command("fix")
  .description("Mark a finding fixed")
  .argument("<locator>", "Finding id, id prefix, or latest:N")
  .requiredOption("--note <text>", "Fix note")
  .option("--verified-by <command>", "Verification command (repeatable)", collectValues, [])
  .option("--commit <ref>", "Commit reference")
  .option("--actor <actor>", "Actor: user or agent", "user")
  .option("--format <format>", "Output format: text or json", "json")
  .action(
    async (
      locator: string,
      options: {
        note: string;
        verifiedBy?: string[];
        commit?: string;
        actor?: string;
        format?: string;
      },
    ) => {
      const verifiedBy = options.verifiedBy ?? [];
      if (verifiedBy.length === 0) {
        failFindingsCommand(
          resolveReviewOutputFormat(options.format),
          new Error("At least one --verified-by command is required."),
        );
      }
      const input: Parameters<typeof fixFindingByLocator>[2] = {
        actor: parseFindingActor(options.actor),
        note: options.note,
        verifiedBy,
      };
      if (options.commit) {
        input.commitRef = options.commit;
      }
      await runFindingMutation(locator, options.format, (db) =>
        fixFindingByLocator(db, locator, input),
      );
    },
  );

findingsCmd
  .command("reopen")
  .description("Reopen a fixed finding")
  .argument("<locator>", "Finding id, id prefix, or latest:N")
  .requiredOption("--reason <text>", "Reopen reason")
  .option("--actor <actor>", "Actor: user or agent", "user")
  .option("--format <format>", "Output format: text or json", "json")
  .action(async (locator: string, options: { reason: string; actor?: string; format?: string }) => {
    await runFindingMutation(locator, options.format, (db) =>
      reopenFindingByLocator(db, locator, {
        actor: parseFindingActor(options.actor),
        reason: options.reason,
      }),
    );
  });

program.parse();

async function runFindingMutation(
  _locator: string,
  formatValue: string | undefined,
  mutate: (db: SqliteDatabase) => import("./state/findings-query.js").FindingDetail,
): Promise<void> {
  await loadConfigOrExit();
  const format = resolveReviewOutputFormat(formatValue);
  try {
    const detail = await withFindingDatabase(await getSharedDiffOwlDir(), mutate);
    if (format === "json") {
      process.stdout.write(renderFindingDetailJson(detail));
      return;
    }
    console.log(formatFindingDetail(detail));
  } catch (err) {
    failFindingsCommand(format, CliErrorSchema.parse(err));
  }
}

function failFindingsCommand(format: ReviewOutputFormat, err: Error): never {
  const message =
    err instanceof LocatorNotFoundError ||
    err instanceof LocatorAmbiguousError ||
    err instanceof InvalidFindingTransitionError
      ? err.message
      : err.message;
  if (format === "json") {
    writeJsonError(message);
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}

function parseFindingActor(value: string | undefined): FindingActor {
  if (value === undefined || value === "user") {
    return "user";
  }
  if (value === "agent") {
    return "agent";
  }
  throw new Error(`Invalid actor: ${value}. Expected user or agent.`);
}

function parsePossibleDuplicateStatus(
  value: string | undefined,
  format: ReviewOutputFormat,
): PossibleDuplicateStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "suggested" || value === "confirmed" || value === "rejected" || value === "expired") return value;
  failFindingsCommand(
    format,
    new Error(`Invalid duplicate status: ${value}. Expected suggested, confirmed, rejected, or expired.`),
  );
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function loadConfigOrExit(): Promise<DiffOwlConfig> {
  return await loadProjectConfigOrExit();
}

async function loadEffectiveReviewConfigOrExit(
  overrides: Parameters<typeof loadEffectiveReviewConfig>[0],
  format: ReviewOutputFormat,
) {
  try {
    return await loadEffectiveReviewConfig(overrides);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (format === "json") {
      writeJsonError(`Config error: ${message}`);
    } else {
      console.error(chalk.red(`Config error: ${message}`));
    }
    process.exit(1);
  }
}

async function loadReviewPreferencesOrExit() {
  try {
    return await loadReviewPreferences();
  } catch (err) {
    failConfigError(CliErrorSchema.parse(err));
  }
}

function failConfigError(error: Error): never {
  console.error(chalk.red(`Config error: ${error.message}`));
  process.exit(1);
}

async function loadProjectConfigOrExit(): Promise<DiffOwlConfig> {
  try {
    return await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Config error: ${message}`));
    process.exit(1);
  }
}

function formatEffectiveModel(selection: ReviewSelection): string {
  return `${chalk.bold(`${formatReviewBackend(selection.backend)} model:`)} ${chalk.cyan(
    selection.requestedModel,
  )} ${chalk.dim(`(${selection.source.model})`)}`;
}

function printReviewExecutionDetails(
  selection: ReviewSelection,
  effectiveModel: string | null,
  jsonMode: boolean,
): void {
  if (jsonMode) return;
  console.log(chalk.dim(`Backend: ${formatReviewBackend(selection.backend)}`));
  console.log(chalk.dim(`Requested model: ${selection.requestedModel}`));
  console.log(chalk.dim(`Effective model: ${effectiveModel ?? "not reported"}`));
  console.log(
    chalk.dim(
      `Preference source: backend=${selection.source.backend}, model=${selection.source.model}`,
    ),
  );
  console.log();
}

function handleReviewInterrupt(input: {
  cancelController: AbortController;
  spinner: ReturnType<typeof ora> | null;
  jsonMode: boolean;
  message: string;
  forceExitCode: number;
}): ReturnType<typeof setTimeout> {
  input.cancelController.abort();
  try {
    input.spinner?.stop();
  } catch {}
  if (!input.jsonMode) {
    console.log(chalk.yellow(`\n${input.message}`));
  }
  return setTimeout(() => process.exit(input.forceExitCode), REVIEW_INTERRUPT_FORCE_EXIT_MS);
}

function appendReviewWarnings(message: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? message : `${message} ${warnings.join(" ")}`;
}

function resolveReviewOutputFormat(
  value: Parameters<typeof parseReviewOutputFormat>[0],
): ReviewOutputFormat {
  try {
    return parseReviewOutputFormat(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  }
}

async function failReview(
  format: ReviewOutputFormat,
  message: string,
  options: { hook?: boolean; hookCommit?: string | undefined; exitCode?: number } = {},
): Promise<never> {
  const exitCode = options.exitCode ?? 1;
  if (format === "json") {
    writeJsonError(message);
  } else {
    console.error(chalk.red(message));
  }
  if (options.hook) {
    await writeHookStatus(1, options.hookCommit, message);
    process.exit(0);
  }
  process.exit(exitCode);
}

async function emitReviewJsonSuccess(input: {
  diffOwlDir: string;
  reviewId: string;
  persisted: PersistReviewRunResult;
  suppressed: {
    outsideChangedFiles: number;
    belowConfidence: number;
  };
  verbose: boolean;
  timings?: ReviewTiming[];
  usage?: ReviewUsage | null;
  selection: ReviewSelection;
  effectiveModel: string | null;
  execution?: ReviewExecutionRecord | null;
}): Promise<void> {
  const review = await getPersistedReview(input.diffOwlDir, input.reviewId);
  if (!review) {
    throw new Error(`Review ${input.reviewId} was not found in state database.`);
  }

  const findingIds = input.persisted.reconcile.observations.map((item) => item.finding.id);
  const occurrenceCounts = await loadFindingOccurrenceCounts(input.diffOwlDir, findingIds);
  const documentInput: BuildReviewJsonInput = {
    review,
    persisted: input.persisted,
    occurrenceCounts,
    suppressed: {
      outsideChangedFiles: input.suppressed.outsideChangedFiles,
      belowConfidence: input.suppressed.belowConfidence,
    },
    verbose: input.verbose,
    selection: input.selection,
    effectiveModel: input.effectiveModel,
  };
  if (input.execution !== undefined) {
    documentInput.execution = input.execution;
  }
  if (input.timings !== undefined) {
    documentInput.timings = input.timings;
  }
  if (input.usage !== undefined) {
    documentInput.usage = input.usage;
  }
  const document = buildReviewJsonDocument(documentInput);
  await writeReviewJsonSuccess(document);
}
