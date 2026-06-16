#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const diffowlRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(diffowlRoot, "dist", "cli.js");

const harmlessSource = `export function formatLabel(label: string) {
  return label.trim();
}
`;

const repeatedClean = `export function loadUser(id: string) {
  if (!id) {
    throw new Error("id is required");
  }
  return { id };
}
`;

const regressionClean = `export async function fetchData(url: string) {
  const response = await fetch(url);
  return response.ok;
}
`;

const repeatedBuggy = `export function loadUser(id: string) {
  // dogfood: missing validation on empty id
  if (id === undefined) {
    return null;
  }
  return { id };
}
`;

const regressionBuggy = `export async function fetchData(url: string) {
  // dogfood: fire-and-forget async call
  void fetch(url);
  return true;
}
`;

function run(command, options = {}) {
  execSync(command, {
    stdio: "inherit",
    ...options,
  });
}

function runCapture(command, cwd) {
  return execSync(command, { cwd, encoding: "utf8" }).trim();
}

async function resolveDogfoodModel() {
  if (process.env.DIFFOWL_DOGFOOD_MODEL?.trim()) {
    return process.env.DIFFOWL_DOGFOOD_MODEL.trim();
  }

  try {
    const config = await readFile(join(diffowlRoot, ".diffowl.yml"), "utf8");
    const parsed = parse(config);
    if (parsed && typeof parsed === "object" && typeof parsed.model === "string") {
      return parsed.model;
    }
  } catch {
    // Fall back to a generic default when the DiffOwl repo has no local config.
  }

  return "opencode-go/big-pickle";
}

async function writeDogfoodFiles(repoDir, model) {
  const config = `model: ${model}
server:
  port: 4096
  auto_start: true
context:
  depth: default
reasoning:
  effort: auto
timeout: 900
min_confidence: low
verbose: true
skip_doc_only: false
include:
  - "src/**/*"
exclude:
  - "**/node_modules/**"
rules:
  - "Treat intentional dogfood bugs as reviewable correctness findings."
  - "Report missing validation, unsafe async usage, and obvious logic errors."
`;

  await writeFile(join(repoDir, ".diffowl.yml"), config, "utf8");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "repeated.ts"), repeatedClean, "utf8");
  await writeFile(join(repoDir, "src", "regression.ts"), regressionClean, "utf8");
  await writeFile(join(repoDir, "src", "harmless.ts"), harmlessSource, "utf8");
  await writeFile(
    join(repoDir, "README.md"),
    "# DiffOwl 0.3 Dogfood Repo\n\nGenerated temporary repo for manual durable lifecycle validation.\n",
    "utf8",
  );
}

function printChecklist(repoDir, model) {
  const cli = `node ${cliPath}`;
  const checklistPath = join(diffowlRoot, "docs", "dogfood", "0.3-checklist.md");

  console.log("");
  console.log("DiffOwl 0.3 dogfood repo ready.");
  console.log("");
  console.log(`Temp repo: ${repoDir}`);
  console.log(`Local CLI: ${cli}`);
  console.log(`Model: ${model}`);
  console.log(`Checklist: ${checklistPath}`);
  console.log("");
  console.log("Staged dogfood issues are ready. Run these commands from the temp repo:");
  console.log("");
  console.log(`  cd ${repoDir}`);
  console.log(`  ${cli} review --staged --verbose`);
  console.log(`  ${cli} review --staged --verbose`);
  console.log(`  ${cli} findings`);
  console.log(`  ${cli} findings show <fnd_id>`);
  console.log(`  ${cli} findings dismiss <repeated_fnd_id> --reason "Dogfood dismissal."`);
  console.log(`  ${cli} review --staged --verbose`);
  console.log(`  ${cli} findings`);
  console.log(
    `  ${cli} findings fix <regression_fnd_id> --note "Dogfood fix." --verified-by "git diff --check" --actor agent`,
  );
  console.log(`  ${cli} review --staged --verbose`);
  console.log(`  ${cli} findings`);
  console.log("  # edit src/harmless.ts, then:");
  console.log(`  git add src/harmless.ts`);
  console.log(`  ${cli} review --staged --verbose`);
  console.log(`  ${cli} findings`);
  console.log(`  ${cli} hook install`);
  console.log(`  git add src/harmless.ts && git commit -m "chore: hook dogfood validation"`);
  console.log(`  ${cli} findings`);
  console.log("");
  console.log("Pass/fail details: docs/dogfood/0.3-checklist.md");
  console.log("");
  console.log(
    "0.3 is done when: pnpm run test and pnpm run lint pass, and this checklist passes once on a fresh repo.",
  );
}

async function main() {
  const model = await resolveDogfoodModel();
  const repoDir = await mkdtemp(join(tmpdir(), "diffowl-dogfood-0.3-"));

  await writeDogfoodFiles(repoDir, model);

  run("git init", { cwd: repoDir, stdio: "pipe" });
  run('git config user.email "dogfood@diffowl.local"', { cwd: repoDir, stdio: "pipe" });
  run('git config user.name "DiffOwl Dogfood"', { cwd: repoDir, stdio: "pipe" });
  run("git add .", { cwd: repoDir, stdio: "pipe" });
  run('git commit -m "chore: dogfood baseline"', { cwd: repoDir, stdio: "pipe" });

  await writeFile(join(repoDir, "src", "repeated.ts"), repeatedBuggy, "utf8");
  await writeFile(join(repoDir, "src", "regression.ts"), regressionBuggy, "utf8");
  run("git add src/repeated.ts src/regression.ts", { cwd: repoDir, stdio: "pipe" });

  const status = runCapture("git status --short", repoDir);
  if (!status.includes("repeated.ts") || !status.includes("regression.ts")) {
    throw new Error("Expected staged dogfood issues before printing checklist.");
  }

  printChecklist(repoDir, model);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dogfood:0.3 failed: ${message}`);
  process.exit(1);
});
