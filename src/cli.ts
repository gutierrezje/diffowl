#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  saveConfig,
  configExists,
  getProjectRoot,
  getDiffOwlDir,
  parseModel,
  parseReviewContextDepth,
  parseReasoningEffort,
  type DiffOwlConfig,
  type ReviewContextDepth,
  type ReviewConfidence,
  type ReasoningEffort,
} from "./config.js";
import {
  runReview,
  getAvailableModels,
  isReviewCancellation,
  type ReviewProgressEvent,
  type ReviewReport,
  type ReviewTiming,
  type ReviewFinding,
} from "./opencode/client.js";
import { getOpenCodeFailureGuidance } from "./opencode/guidance.js";
import { canSelectModelInteractively, selectModel } from "./opencode/model-selection.js";
import {
  ensureServer,
  getInstalledOpencodeVersion,
  getServerHealth,
  isServerRunning,
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
  runHookReview,
  runPendingHookReviews,
  releaseHookReviewLock,
  writeHookStatus,
} from "./git/hooks.js";
import { isGitRepo, hasCommits, isDocOnlyDiff, resolveCommitRef } from "./git/diff.js";
import {
  buildReviewContextFromDiff,
  loadReviewSnapshot,
  renderReviewContext,
} from "./review/context.js";
import {
  printHeader,
  printFooter,
  writeMarkdownReport,
  renderMarkdown,
  colorizeMarkdown,
  formatExcludedCandidateSummary,
  parseReviewMetadata,
} from "./review/formatter.js";
import {
  canSelectReviewInteractively,
  listReviewReportPaths,
  resolveReviewReportPath,
  selectReviewReportPath,
} from "./review/report-path.js";
import {
  computeDiffHash,
  formatLifecycleSuppressedSummary,
  getPersistedReview,
  loadFindingOccurrenceCounts,
  mapReviewTarget,
  persistReviewRun,
  updatePersistedReview,
  type PersistReviewRunResult,
} from "./state/persist.js";
import {
  buildReviewJsonDocument,
  parseReviewOutputFormat,
  writeJsonError,
  writeReviewJsonSuccess,
  type ReviewOutputFormat,
} from "./output/json.js";

import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { execa } from "execa";
import packageJson from "../package.json" with { type: "json" };

const program = new Command();

program
  .name("diffowl")
  .description("Local AI code review agent powered by OpenCode")
  .version(packageJson.version);

// Default command: review last commit
program
  .command("review", { isDefault: true })
  .description("Review the last commit or staged changes")
  .option("--staged", "Review staged changes instead of last commit")
  .option("--commit <ref>", "Review a specific commit ref instead of HEAD")
  .option("--hook", "Running from git hook (non-blocking mode)")
  .option("--depth <depth>", "Review context depth: shallow or default")
  .option(
    "--reasoning <effort>",
    "Reasoning variant: auto, none, minimal, low, medium, high, max, or xhigh",
  )
  .option("--verbose", "Include suppressed findings and extra review details")
  .option("--format <format>", "Output format: text or json", "text")
  .action(async (options) => {
    const format = resolveReviewOutputFormat(options.format);
    const jsonMode = format === "json";
    const hookCommit = options.hook && options.commit ? String(options.commit) : undefined;
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
    recordCliTiming(timings, "git-repo-check", "Git repository check", gitRepoStart);
    if (!isRepo) {
      await failReview(format, "Not a git repository", { hook: options.hook, hookCommit });
    }

    // First run: prompt for setup
    if (!configExists()) {
      console.log(chalk.yellow("No .diffowl.yml found. Running first-time setup...\n"));
      await runInit();
    }

    const config = await loadConfigOrExit();
    const projectRoot = getProjectRoot();
    if (options.staged && options.commit) {
      await failReview(format, "Cannot use --staged and --commit together", {
        hook: options.hook,
        hookCommit,
      });
    }

    const target = options.staged
      ? ({ kind: "staged" } as const)
      : options.commit
        ? ({ kind: "commit", ref: String(options.commit) } as const)
        : ({ kind: "last-commit" } as const);
    const depth = resolveReviewDepth(options.depth, config);
    config.reasoning.effort = resolveReasoningEffort(options.reasoning, config);
    const verbose = Boolean(config.verbose || options.verbose);

    if (target.kind !== "staged") {
      const hasCommitsStart = performance.now();
      const commitsExist = await hasCommits();
      recordCliTiming(timings, "git-commit-check", "Git commit check", hasCommitsStart);
      if (!commitsExist) {
        await failReview(format, "No commits found in this repository", {
          hook: options.hook,
          hookCommit,
        });
      }
    }

    if (!jsonMode) {
      printHeader();
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

    // Register signal handlers immediately after spinner starts so they
    // cover the entire review lifecycle (context build, server connect, SSE).
    // discardStdin: false above ensures the terminal delivers SIGINT natively
    // instead of routing through stdin-discarder's raw-mode byte conversion.
    process.once("SIGINT", () => {
      handleReviewInterrupt({
        cancelController,
        spinner,
        jsonMode,
        message: "Review cancelled by user (Ctrl+C).",
        exitCode: 130,
        hook: options.hook,
        hookCommit,
      });
    });
    process.once("SIGTSTP", () => {
      handleReviewInterrupt({
        cancelController,
        spinner,
        jsonMode,
        message: "Review cancelled by user (Ctrl+Z).",
        exitCode: 146,
        hook: options.hook,
        hookCommit,
      });
    });

    try {
      const snapshot = await loadReviewSnapshot(projectRoot, target);
      const { diff } = snapshot;

      if (target.kind === "staged" && diff.files.length === 0) {
        spinner?.stop();
        if (jsonMode) {
          writeJsonError("No staged changes to review");
          process.exit(0);
        }
        console.log(chalk.yellow("No staged changes to review"));
        process.exit(0);
      }

      if (config.skip_doc_only && isDocOnlyDiff(diff)) {
        spinner?.stop();
        if (!jsonMode) {
          console.warn(chalk.yellow("Documentation-only changes detected. Skipping review."));
        }
        const skipContent = buildDocOnlySkipMarkdown(diff);
        const diffHash = computeDiffHash(diff.raw);
        const targetFields = mapReviewTarget(target);
        const targetCommit = await resolveTargetCommit(target);
        const persisted = await persistReviewRun(getDiffOwlDir(), {
          ...targetFields,
          targetCommit,
          diffHash,
          model: config.model,
          reasoning: config.reasoning.effort,
          depth,
          sessionId: "",
          summary: "Documentation-only changes detected. No code review performed.",
          diagnostics: [],
          timings,
          findings: [],
          skippedReason: "documentation-only",
        });
        let reportPath: string;
        try {
          reportPath = await writeMarkdownReport(skipContent);
          await updatePersistedReview(getDiffOwlDir(), persisted.reviewId, {
            reportPath,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await updatePersistedReview(getDiffOwlDir(), persisted.reviewId, {
            reportPath: null,
            diagnostics: [`Report write failed: ${message}`],
          });
          throw err;
        }
        if (jsonMode) {
          await emitReviewJsonSuccess({
            diffOwlDir: getDiffOwlDir(),
            reviewId: persisted.reviewId,
            persisted,
            suppressed: { outsideChangedFiles: 0, belowConfidence: 0 },
            verbose,
            timings,
          });
        } else {
          console.log(chalk.dim(`Report saved: ${reportPath}`));
        }
        if (options.hook) {
          await writeHookStatus(0, hookCommit);
        }
        process.exit(0);
      }

      const contextStart = performance.now();
      const reviewContext = await buildReviewContextFromDiff(snapshot, config, depth);
      recordCliTiming(timings, "context-build", "Local review context build", contextStart);

      const contextRenderStart = performance.now();
      const localContext = renderReviewContext(reviewContext, { depth });
      recordCliTiming(timings, "context-render", "Local review context render", contextRenderStart);

      if (reviewContext.diagnostics.length > 0 && spinner) {
        spinner.warn("Local review context built with warnings.");
        for (const diagnostic of reviewContext.diagnostics) {
          console.log(chalk.yellow(`  - ${diagnostic}`));
        }
        console.log();
        spinner.start("Connecting to OpenCode...");
      }

      // Ensure server and start review
      if (spinner) {
        spinner.text = "Connecting to OpenCode...";
      }
      const serverStart = performance.now();
      await prepareReviewServer(config);
      recordCliTiming(timings, "server-ensure", "OpenCode server ensure", serverStart);
      if (spinner) {
        spinner.text = "Reviewing changes...";
      }

      const reviewStart = performance.now();
      const reviewResult = await runReview({
        target,
        directory: projectRoot,
        config,
        localContext,
        depth,
        signal: cancelController.signal,
        onProgress: (event) => {
          if (spinner) {
            spinner.text = formatReviewProgress(event);
          }
        },
      });
      const report: ReviewReport = reviewResult.report;
      recordCliTiming(timings, "review-run", "OpenCode review run", reviewStart);
      spinner?.succeed("Review complete.");
      if (!jsonMode) {
        console.log(); // Space after spinner
      }

      const diagnostics = report.diagnostics ?? [];

      const confidenceFilter = filterFindingsByConfidence(report.findings, config.min_confidence);
      report.findings = confidenceFilter.findings;

      const changedFilesSet = new Set<string>();
      for (const file of reviewContext.changedFiles) {
        changedFilesSet.add(file.file.path);
      }
      const changedFileFilter = filterFindingsByChangedFiles(report.findings, changedFilesSet);
      report.findings = changedFileFilter.findings;
      if (changedFileFilter.suppressed.length > 0) {
        if (verbose) {
          report.suppressedFindings = changedFileFilter.suppressed;
        }
      }
      if (confidenceFilter.dropped > 0 || changedFileFilter.suppressed.length > 0) {
        diagnostics.push(
          formatExcludedCandidateSummary(
            confidenceFilter.dropped,
            changedFileFilter.suppressed.length,
          ),
        );
      }
      if (diagnostics.length > 0) {
        report.diagnostics = diagnostics;
      }

      const diffHash = computeDiffHash(diff.raw);
      const targetFields = mapReviewTarget(target);
      const targetCommit = await resolveTargetCommit(target);
      const persistStart = performance.now();
      const persisted = await persistReviewRun(getDiffOwlDir(), {
        ...targetFields,
        targetCommit,
        diffHash,
        model: config.model,
        reasoning: config.reasoning.effort,
        depth,
        sessionId: reviewResult.sessionId,
        summary: report.summary,
        diagnostics,
        timings: [...timings, ...(report.timings ?? [])],
        findings: report.findings,
      });
      recordCliTiming(timings, "persist-state", "Persist review state", persistStart);

      report.findings = persisted.actionableFindings;
      const lifecycleSummary = formatLifecycleSuppressedSummary(
        persisted.reconcile.suppressedCounts,
      );
      if (lifecycleSummary) {
        diagnostics.push(lifecycleSummary);
        report.diagnostics = diagnostics;
      }
      if (verbose && persisted.lifecycleSuppressedFindings.length > 0) {
        report.suppressedFindings = [
          ...(report.suppressedFindings ?? []),
          ...persisted.lifecycleSuppressedFindings,
        ];
      }

      const renderStart = performance.now();
      const markdown = renderMarkdown(report);
      recordCliTiming(timings, "render-report", "Markdown render", renderStart);

      // Write markdown report
      const writeStart = performance.now();
      let reportPath: string;
      try {
        reportPath = await writeMarkdownReport(markdown, {
          session_id: reviewResult.sessionId,
          project_root: projectRoot,
        });
        await updatePersistedReview(getDiffOwlDir(), persisted.reviewId, {
          reportPath,
          diagnostics,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.push(`Report write failed: ${message}`);
        report.diagnostics = diagnostics;
        await updatePersistedReview(getDiffOwlDir(), persisted.reviewId, {
          reportPath: null,
          diagnostics,
        });
        throw err;
      }
      recordCliTiming(timings, "write-report", "Report write", writeStart);
      recordCliTiming(timings, "total", "Total review command", totalStart);

      if (jsonMode) {
        await emitReviewJsonSuccess({
          diffOwlDir: getDiffOwlDir(),
          reviewId: persisted.reviewId,
          persisted,
          suppressed: {
            outsideChangedFiles: changedFileFilter.suppressed.length,
            belowConfidence: confidenceFilter.dropped,
          },
          verbose,
          timings: [...timings, ...(report.timings ?? [])],
        });
      } else {
        // Print the rendered, colorized markdown to stdout
        console.log(colorizeMarkdown(markdown));

        printFooter(report, reportPath);
        printTimingSummary([...timings, ...(report.timings ?? [])]);
      }
      if (options.hook) {
        await writeHookStatus(0, hookCommit);
        process.exit(0);
      }
    } catch (err) {
      spinner?.stop();
      if (cancelController.signal.aborted || isReviewCancellation(err)) {
        if (options.hook) {
          await writeHookStatus(1, hookCommit, "Review cancelled by user.");
          process.exit(0);
        }
        if (!cancelController.signal.aborted) {
          process.exit(130);
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        writeJsonError(message);
      } else {
        console.error(chalk.red(`\nReview failed: ${message}`));
        for (const line of getOpenCodeFailureGuidance(message)) {
          console.log(chalk.dim(line));
        }
      }
      if (options.hook) {
        await writeHookStatus(1, hookCommit, message);
        process.exit(0);
      }
      process.exit(1);
    }
  });

program
  .command("chat")
  .description("Open the OpenCode session for a review")
  .argument("[report]", "Review report path or filename")
  .action(async (report?: string) => {
    const reportPath = report ? resolveReviewReportPath(report) : await selectReviewInteractively();

    let content: string;
    try {
      content = await readFile(reportPath, "utf-8");
    } catch {
      console.error(chalk.red(`Review report not found: ${reportPath}`));
      process.exit(1);
    }

    let metadata;
    try {
      metadata = parseReviewMetadata(content);
    } catch {
      console.error(chalk.red(`Invalid review metadata: ${reportPath}`));
      process.exit(1);
    }

    if (!metadata) {
      console.error(
        chalk.red(`Review report does not contain chat session metadata: ${reportPath}`),
      );
      process.exit(1);
    }

    try {
      await execa("opencode", [metadata.project_root, "--session", metadata.session_id], {
        stdio: "inherit",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Failed to open review session: ${message}`));
      for (const line of getOpenCodeFailureGuidance(message)) {
        console.log(chalk.dim(line));
      }
      process.exit(1);
    }
  });

async function selectReviewInteractively(): Promise<string> {
  if (!canSelectReviewInteractively(process.stdin.isTTY, process.stdout.isTTY)) {
    console.error(
      chalk.red(
        "Interactive review selection requires a terminal. Pass a report filename or path instead.",
      ),
    );
    process.exit(1);
  }

  const reports = await listReviewReportPaths();
  if (reports.length === 0) {
    console.error(chalk.red("No review reports available. Run `diffowl review` first."));
    process.exit(1);
  }

  console.log(chalk.bold("\nSelect a review:\n"));
  for (const [index, report] of reports.entries()) {
    const resolved = basename(dirname(report)) === "resolved";
    console.log(
      `  ${chalk.cyan(`${index + 1}.`)} ${basename(report)}${resolved ? chalk.dim(" (resolved)") : ""}`,
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const selected = selectReviewReportPath(
        reports,
        await rl.question(chalk.yellow("\nReview number: ")),
      );
      if (selected) return selected;
      console.log(chalk.red(`Enter a number between 1 and ${reports.length}.`));
    }
  } finally {
    rl.close();
  }
}

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
    const parsed = JSON.parse(stdout) as { version?: unknown; modules?: unknown };
    if (typeof parsed.version === "string" && typeof parsed.modules === "string") {
      return `${node} (${parsed.version}, ABI ${parsed.modules})`;
    }
  } catch {}
  return node;
}

function resolveReviewDepth(value: unknown, config: DiffOwlConfig): ReviewContextDepth {
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

function resolveReasoningEffort(value: unknown, config: DiffOwlConfig): ReasoningEffort {
  if (value === undefined) {
    return config.reasoning.effort;
  }

  try {
    return parseReasoningEffort(value);
  } catch {
    console.error(chalk.red(`Invalid reasoning effort: ${String(value)}`));
    console.error(chalk.dim("Expected one of: auto, none, minimal, low, medium, high, max, xhigh"));
    process.exit(1);
  }
}

function recordCliTiming(
  timings: ReviewTiming[],
  phase: string,
  label: string,
  start: number,
): void {
  timings.push({ phase, label, ms: performance.now() - start });
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function prepareReviewServer(config: DiffOwlConfig): Promise<void> {
  if (config.server.auto_start) {
    await ensureServer(config.server.port);
    return;
  }

  if (await isServerRunning(config.server.port)) {
    return;
  }

  throw new Error(
    `OpenCode server is not running on port ${config.server.port}. Start it with \`diffowl server start\` or set server.auto_start: true.`,
  );
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
  const config = await loadConfigOrExit();
  await selectModelInteractively(config, { allowKeepCurrent: false });
}

// Model command
program
  .command("model")
  .description("View or change the AI model")
  .argument("[model]", "Model to use (e.g., opencode-go/big-pickle)")
  .action(async (model?: string) => {
    const config = await loadConfigOrExit();

    if (!model) {
      console.log(chalk.bold("Current model: ") + chalk.cyan(config.model));
      await selectModelInteractively(config, { allowKeepCurrent: true });
      return;
    }

    let parsedModel: string;
    try {
      parsedModel = parseModel(model);
    } catch {
      console.error(chalk.red(`Invalid model: ${model}`));
      console.error(
        chalk.dim("Expected provider/model format, for example opencode-go/big-pickle"),
      );
      process.exit(1);
    }

    config.model = parsedModel;
    const configPath = await saveConfig(config);
    console.log(chalk.green(`✓ Model set to ${chalk.cyan(parsedModel)}`));
    console.log(chalk.dim(`Config: ${configPath}`));
  });

async function selectModelInteractively(
  config: DiffOwlConfig,
  options: { allowKeepCurrent: boolean },
): Promise<void> {
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

  let selectedModel = config.model;

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
          config.model,
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
    console.log(chalk.yellow("\nNo active/connected providers found in OpenCode."));
    console.log(
      chalk.dim("Make sure you run ") +
        chalk.cyan("opencode") +
        chalk.dim(" to authenticate and set up your providers/keys first."),
    );
    console.log(chalk.dim("Using fallback default model: ") + chalk.cyan(config.model));
    console.log();
  }

  // Only update/save if a new model was selected or config is being initialized
  if (selectedModel !== config.model || !options.allowKeepCurrent) {
    config.model = selectedModel;
    const configPath = await saveConfig(config);
    if (options.allowKeepCurrent) {
      console.log(chalk.green(`✓ Model set to ${chalk.cyan(selectedModel)}`));
    } else {
      console.log(chalk.green(`✓ Config saved to ${configPath}`));
      console.log(chalk.dim(`Model set to: `) + chalk.cyan(selectedModel));
    }
    console.log();
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

    const alreadyInstalled = await isHookInstalled();
    const hookPath = await installHook();
    const command = await getHookCommand();
    const action = alreadyInstalled ? "updated" : "installed";
    console.log(chalk.green(`✓ Post-commit hook ${action}: ${hookPath}`));
    console.log(chalk.dim(`Hook Node: ${await describeNodeRuntime(command.node)}`));
    console.log(chalk.dim(`Hook Entrypoint: ${command.cli}`));
    console.log(chalk.dim("Reviews will run automatically after each commit (non-blocking)"));
    console.log(
      chalk.dim("Hook output: .diffowl/hook.log; latest report: .diffowl/reviews/latest.md"),
    );
  });

hookCmd
  .command("status")
  .description("Check if the post-commit hook is installed and up to date")
  .action(async () => {
    const status = await checkHookStale();

    if (!status.installed) {
      console.log(chalk.yellow(`✗ ${status.reason ?? "Hook not installed"}`));
      return;
    }

    if (status.stale) {
      console.log(chalk.yellow("⚠ Hook is installed but stale"));
      console.log(chalk.dim(`Reason: ${status.reason}`));
      console.log(chalk.dim("Run `diffowl hook install` to update it."));
      return;
    }

    console.log(chalk.green("✓ Hook is installed and up to date"));
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
    await runPendingHookReviews();
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

program.parse();

async function loadConfigOrExit(): Promise<DiffOwlConfig> {
  try {
    return await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Config error: ${message}`));
    process.exit(1);
  }
}

function filterFindingsByConfidence(
  findings: ReviewFinding[],
  minConfidence: ReviewConfidence,
): { findings: ReviewFinding[]; dropped: number } {
  const levels = ["low", "medium", "high"];
  const minIndex = levels.indexOf(minConfidence);

  const kept = findings.filter((f) => {
    const idx = levels.indexOf(f.confidence.toLowerCase());
    return idx >= minIndex;
  });
  return { findings: kept, dropped: findings.length - kept.length };
}

function filterFindingsByChangedFiles(
  findings: ReviewFinding[],
  changedFiles: Set<string>,
): { findings: ReviewFinding[]; suppressed: ReviewFinding[] } {
  const kept: ReviewFinding[] = [];
  const suppressed: ReviewFinding[] = [];
  for (const finding of findings) {
    // If the file wasn't changed in this diff at all, it's a hallucinated file.
    // Drop it unconditionally, since confidence is not a guarantee of correctness.
    if (changedFiles.has(finding.file)) {
      kept.push(finding);
    } else {
      suppressed.push(finding);
    }
  }
  return { findings: kept, suppressed };
}

function buildDocOnlySkipMarkdown(diff: {
  files: { path: string; additions: number; deletions: number }[];
}): string {
  const lines: string[] = [];
  lines.push("### Summary");
  lines.push("Documentation-only changes detected. No code review performed.");
  lines.push("");
  lines.push("### Changed Files");
  for (const file of diff.files) {
    lines.push(`- ${file.path} (+${file.additions}/-${file.deletions})`);
  }
  return lines.join("\n");
}

async function resolveTargetCommit(
  target: { kind: "staged" } | { kind: "last-commit" } | { kind: "commit"; ref: string },
): Promise<string | null> {
  switch (target.kind) {
    case "staged":
      return null;
    case "last-commit":
      return resolveCommitRef("HEAD");
    case "commit":
      return resolveCommitRef(target.ref);
  }
}

function handleReviewInterrupt(input: {
  cancelController: AbortController;
  spinner: ReturnType<typeof ora> | null;
  jsonMode: boolean;
  message: string;
  exitCode: number;
  hook?: boolean;
  hookCommit?: string | undefined;
}): void {
  input.cancelController.abort();
  try {
    input.spinner?.stop();
  } catch {}
  if (input.jsonMode) {
    writeJsonError(input.message);
  } else {
    console.log(chalk.yellow(`\n${input.message}`));
  }
  if (input.hook) {
    const forceExit = setTimeout(() => process.exit(0), 2000);
    void writeHookStatus(1, input.hookCommit, input.message).finally(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
    return;
  }
  // Force exit if the review loop does not unwind promptly after abort.
  setTimeout(() => process.exit(input.exitCode), 750).unref();
}

function resolveReviewOutputFormat(value: unknown): ReviewOutputFormat {
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
}): Promise<void> {
  const review = await getPersistedReview(input.diffOwlDir, input.reviewId);
  if (!review) {
    throw new Error(`Review ${input.reviewId} was not found in state database.`);
  }

  const findingIds = input.persisted.reconcile.observations.map((item) => item.finding.id);
  const occurrenceCounts = await loadFindingOccurrenceCounts(input.diffOwlDir, findingIds);
  const document = buildReviewJsonDocument({
    review,
    persisted: input.persisted,
    occurrenceCounts,
    suppressed: {
      outsideChangedFiles: input.suppressed.outsideChangedFiles,
      belowConfidence: input.suppressed.belowConfidence,
    },
    verbose: input.verbose,
    ...(input.timings ? { timings: input.timings } : {}),
  });
  writeReviewJsonSuccess(document);
}
