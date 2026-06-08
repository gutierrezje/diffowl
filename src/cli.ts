#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  saveConfig,
  configExists,
  ensureDiffOwlDir,
  getProjectRoot,
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
  type ReviewProgressEvent,
  type ReviewReport,
  type ReviewTiming,
  type ReviewFinding,
} from "./opencode/client.js";
import { ensureServer, isServerRunning, stopServer } from "./opencode/server.js";
import {
  installHook,
  uninstallHook,
  isHookInstalled,
  checkHookStale,
  checkRecentHookFailure,
  formatHookFailure,
  runHookReview,
  runPendingHookReviews,
  releaseHookReviewLock,
} from "./git/hooks.js";
import {
  isGitRepo,
  hasCommits,
  getCommitDiff,
  getLastCommitDiff,
  getStagedDiff,
  isDocOnlyDiff,
} from "./git/diff.js";
import { buildReviewContext, renderReviewContext } from "./review/context.js";
import {
  printHeader,
  printFooter,
  writeMarkdownReport,
  renderMarkdown,
  colorizeMarkdown,
  parseReviewMetadata,
} from "./review/formatter.js";
import { resolveReviewReportPath } from "./review/report-path.js";

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import packageJson from "../package.json" with { type: "json" };

async function writeHookStatus(
  exitCode: number,
  commit?: string,
  message?: string,
): Promise<void> {
  try {
    const dir = await ensureDiffOwlDir();
    const content = JSON.stringify(
      {
        ...(commit ? { commit } : {}),
        exitCode,
        timestamp: new Date().toISOString(),
        ...(message ? { message } : {}),
      },
      null,
      2,
    );
    await writeFile(join(dir, "last-hook-status.json"), content, "utf-8");

    const resultPath = process.env["DIFFOWL_HOOK_RESULT"];
    if (resultPath) {
      await writeFile(resultPath, content, "utf-8");
    }
  } catch {
    // Best-effort: status file is advisory only
  }
}

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
  .action(async (options) => {
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
      console.error(chalk.red("Not a git repository"));
      process.exit(1);
    }

    // First run: prompt for setup
    if (!configExists()) {
      console.log(chalk.yellow("No .diffowl.yml found. Running first-time setup...\n"));
      await runInit();
    }

    const config = await loadConfigOrExit();
    if (options.staged && options.commit) {
      console.error(chalk.red("Cannot use --staged and --commit together"));
      process.exit(1);
    }

    const mode = options.staged ? "staged" : options.commit ? "commit" : "last-commit";
    const depth = resolveReviewDepth(options.depth, config);
    config.reasoning.effort = resolveReasoningEffort(options.reasoning, config);
    const verbose = Boolean(config.verbose || options.verbose);

    if (mode !== "staged") {
      const hasCommitsStart = performance.now();
      const commitsExist = await hasCommits();
      recordCliTiming(timings, "git-commit-check", "Git commit check", hasCommitsStart);
      if (!commitsExist) {
        console.error(chalk.red("No commits found in this repository"));
        process.exit(1);
      }
    }

    printHeader();

    const hookFailure = await checkRecentHookFailure();
    if (hookFailure) {
      console.log(chalk.yellow(`⚠ ${formatHookFailure(hookFailure)}`));
      console.log();
    }

    const diff =
      mode === "staged"
        ? await getStagedDiff()
        : mode === "commit"
          ? await getCommitDiff(String(options.commit))
          : await getLastCommitDiff();
    if (config.skip_doc_only && isDocOnlyDiff(diff)) {
      console.warn(chalk.yellow("Documentation-only changes detected. Skipping review."));
      const skipContent = buildDocOnlySkipMarkdown(diff);
      const reportPath = await writeMarkdownReport(
        skipContent,
        undefined,
        config.retention.reviews,
      );
      console.log(chalk.dim(`Report saved: ${reportPath}`));
      if (options.hook) {
        await writeHookStatus(0, hookCommit);
      }
      process.exit(0);
    }

    const spinner = ora({
      text: "Building local review context...",
      color: "cyan",
      discardStdin: false,
    }).start();

    // Register signal handlers immediately after spinner starts so they
    // cover the entire review lifecycle (context build, server connect, SSE).
    // discardStdin: false above ensures the terminal delivers SIGINT natively
    // instead of routing through stdin-discarder's raw-mode byte conversion.
    process.once("SIGINT", () => {
      try {
        spinner.stop();
      } catch {}
      console.log(chalk.yellow("\nReview cancelled by user (Ctrl+C)."));
      process.exit(130);
    });
    process.once("SIGTSTP", () => {
      try {
        spinner.stop();
      } catch {}
      console.log(chalk.yellow("\nReview cancelled by user (Ctrl+Z)."));
      process.exit(146);
    });

    try {
      const contextStart = performance.now();
      const reviewContext = await buildReviewContext(mode, config, depth, diff);
      recordCliTiming(timings, "context-build", "Local review context build", contextStart);

      if (mode === "staged" && reviewContext.diff.files.length === 0) {
        spinner.stop();
        console.log(chalk.yellow("No staged changes to review"));
        process.exit(0);
      }

      const contextRenderStart = performance.now();
      const localContext = renderReviewContext(reviewContext, { depth });
      recordCliTiming(timings, "context-render", "Local review context render", contextRenderStart);

      if (reviewContext.diagnostics.length > 0) {
        spinner.warn("Local review context built with warnings.");
        for (const diagnostic of reviewContext.diagnostics) {
          console.log(chalk.yellow(`  - ${diagnostic}`));
        }
        console.log();
        spinner.start("Connecting to OpenCode...");
      }

      // Ensure server and start review
      spinner.text = "Connecting to OpenCode...";
      const serverStart = performance.now();
      await prepareReviewServer(config);
      recordCliTiming(timings, "server-ensure", "OpenCode server ensure", serverStart);
      spinner.text = "Reviewing changes...";

      const reviewStart = performance.now();
      const reviewResult = await runReview({
        mode,
        config,
        localContext,
        depth,
        onProgress: (event) => {
          spinner.text = formatReviewProgress(event);
        },
      });
      const report: ReviewReport = reviewResult.report;
      recordCliTiming(timings, "review-run", "OpenCode review run", reviewStart);
      spinner.succeed("Review complete.");
      console.log(); // Space after spinner

      const diagnostics = report.diagnostics ?? [];

      const confidenceFilter = filterFindingsByConfidence(report.findings, config.min_confidence);
      report.findings = confidenceFilter.findings;
      if (confidenceFilter.dropped > 0) {
        diagnostics.push(
          `Dropped ${confidenceFilter.dropped} finding(s) below min_confidence=${config.min_confidence}.`,
        );
      }

      const changedFilesSet = new Set<string>();
      for (const file of reviewContext.changedFiles) {
        changedFilesSet.add(file.file.path);
      }
      const changedFileFilter = filterFindingsByChangedFiles(report.findings, changedFilesSet);
      report.findings = changedFileFilter.findings;
      if (changedFileFilter.suppressed.length > 0) {
        diagnostics.push(
          `Suppressed ${changedFileFilter.suppressed.length} finding(s) for files not changed in this diff.`,
        );
        if (verbose) {
          report.suppressedFindings = changedFileFilter.suppressed;
        }
      }
      if (diagnostics.length > 0) {
        report.diagnostics = diagnostics;
      }

      const renderStart = performance.now();
      const markdown = renderMarkdown(report);
      recordCliTiming(timings, "render-report", "Markdown render", renderStart);

      // Write markdown report
      const writeStart = performance.now();
      const reportPath = await writeMarkdownReport(
        markdown,
        {
          session_id: reviewResult.sessionId,
          project_root: getProjectRoot(),
        },
        config.retention.reviews,
      );
      recordCliTiming(timings, "write-report", "Report write", writeStart);
      recordCliTiming(timings, "total", "Total review command", totalStart);

      // Print the rendered, colorized markdown to stdout
      console.log(colorizeMarkdown(markdown));

      printFooter(report, reportPath);
      printTimingSummary([...timings, ...(report.timings ?? [])]);
      if (options.hook) {
        await writeHookStatus(0, hookCommit);
        process.exit(0);
      }
    } catch (err) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nReview failed: ${message}`));
      if (message.includes("opencode not found")) {
        console.log(chalk.dim("Install: npm i -g opencode-ai"));
        console.log(chalk.dim("Docs: https://opencode.ai/docs/"));
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
  .argument("[report]", "Review report path or filename", "latest.md")
  .action(async (report: string) => {
    const reportPath = resolveReviewReportPath(report);

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
      if (message.includes("opencode not found")) {
        console.log(chalk.dim("Install: npm i -g opencode-ai"));
        console.log(chalk.dim("Docs: https://opencode.ai/docs/"));
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
  } catch {
    spinner.fail("Failed to query models from OpenCode server.");
  }

  let selectedModel = config.model;

  if (models.length > 0) {
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

        const answer = await rl.question(chalk.yellow(promptText));
        const trimmed = answer.trim();

        if (trimmed === "") {
          if (options.allowKeepCurrent) {
            break; // Keep current model
          } else {
            selectedModel = models[0]!;
            break;
          }
        }

        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= models.length) {
          selectedModel = models[num - 1]!;
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
    const action = alreadyInstalled ? "updated" : "installed";
    console.log(chalk.green(`✓ Post-commit hook ${action}: ${hookPath}`));
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
    if (await stopServer()) {
      console.log(chalk.green("✓ Server stopped"));
    } else {
      console.log(chalk.yellow("No managed server found"));
    }
  });

serverCmd
  .command("status")
  .description("Check if the OpenCode server is running")
  .action(async () => {
    const config = await loadConfigOrExit();
    const running = await isServerRunning(config.server.port);
    if (running) {
      console.log(chalk.green(`✓ Server running on port ${config.server.port}`));
    } else {
      console.log(chalk.yellow(`✗ No server on port ${config.server.port}`));
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
