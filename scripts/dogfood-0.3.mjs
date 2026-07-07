#!/usr/bin/env node
import { mkdir, readFile, writeFile, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { parse, stringify } from "yaml";

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

async function run(command, args, options = {}) {
  await execa(command, args, {
    stdio: "inherit",
    ...options,
  });
}

async function runCapture(command, args, cwd) {
  const { stdout } = await execa(command, args, { cwd });
  return stdout.trim();
}

async function ensureBuiltCli() {
  try {
    await access(cliPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Built CLI not found at ${cliPath}. Run pnpm run build first.`);
    }
    throw error;
  }
}

async function resolveDogfoodModel() {
  if (process.env.DIFFOWL_DOGFOOD_MODEL?.trim()) {
    return process.env.DIFFOWL_DOGFOOD_MODEL.trim();
  }

  const configPath = join(diffowlRoot, ".diffowl.yml");
  let config;
  try {
    config = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "opencode/big-pickle";
    }
    throw error;
  }

  const parsed = parse(config);
  if (!parsed || typeof parsed !== "object" || typeof parsed.model !== "string") {
    throw new Error(`${configPath} must contain a string model value.`);
  }

  return parsed.model;
}

async function writeDogfoodFiles(repoDir, model) {
  const config = stringify({
    model,
    server: {
      port: 4096,
      auto_start: true,
    },
    context: {
      depth: "default",
    },
    reasoning: {
      effort: "auto",
    },
    timeout: 900,
    min_confidence: "low",
    verbose: true,
    skip_doc_only: false,
    include: ["src/**/*"],
    exclude: ["**/node_modules/**"],
    rules: [
      "Treat intentional dogfood bugs as reviewable correctness findings.",
      "Report missing validation, unsafe async usage, and obvious logic errors.",
    ],
  });

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
  const checklistPath = join(diffowlRoot, "dev-docs", "dogfood", "0.3-checklist.md");

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
  console.log('  git commit -m "chore: dogfood bug fixtures"');
  console.log("  # edit src/harmless.ts, then:");
  console.log(`  git add src/harmless.ts`);
  console.log("  git status --short   # only src/harmless.ts should be staged");
  console.log(`  ${cli} review --staged --verbose`);
  console.log(`  ${cli} findings`);
  console.log(`  ${cli} hook install`);
  console.log("  # edit src/harmless.ts if needed, then:");
  console.log(`  git add src/harmless.ts`);
  console.log("  git status --short   # only src/harmless.ts should be staged");
  console.log('  git commit -m "chore: hook dogfood validation"');
  console.log(`  ${cli} findings`);
  console.log("");
  console.log("Pass/fail details: dev-docs/dogfood/0.3-checklist.md");
  console.log("");
  console.log(
    "0.3 is done when: pnpm run test and pnpm run lint pass, and this checklist passes once on a fresh repo.",
  );
}

async function main() {
  await ensureBuiltCli();
  const model = await resolveDogfoodModel();
  const repoDir = await mkdtemp(join(tmpdir(), "diffowl-dogfood-0.3-"));

  await writeDogfoodFiles(repoDir, model);

  await run("git", ["init"], { cwd: repoDir, stdio: "pipe" });
  await run("git", ["config", "user.email", "dogfood@diffowl.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  await run("git", ["config", "user.name", "DiffOwl Dogfood"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  await run("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  await run("git", ["commit", "-m", "chore: dogfood baseline"], {
    cwd: repoDir,
    stdio: "pipe",
  });

  await writeFile(join(repoDir, "src", "repeated.ts"), repeatedBuggy, "utf8");
  await writeFile(join(repoDir, "src", "regression.ts"), regressionBuggy, "utf8");
  await run("git", ["add", "src/repeated.ts", "src/regression.ts"], {
    cwd: repoDir,
    stdio: "pipe",
  });

  const status = await runCapture("git", ["status", "--short"], repoDir);
  if (!status.includes("repeated.ts") || !status.includes("regression.ts")) {
    throw new Error("Expected staged dogfood issues before printing checklist.");
  }

  printChecklist(repoDir, model);
}

function isNodeError(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dogfood:0.3 failed: ${message}`);
  process.exit(1);
});
