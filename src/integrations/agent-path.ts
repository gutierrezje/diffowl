import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installClaudeCodeHook } from "./claude-code.js";

export const AGENT_PATH_INSTRUCTION_START = "<!-- DIFFOWL:AGENT-PATH:START -->";
export const AGENT_PATH_INSTRUCTION_END = "<!-- DIFFOWL:AGENT-PATH:END -->";

export const AGENT_PATH_INSTRUCTION = [
  "## DiffOwl",
  "",
  "Before opening a pull request, run `diffowl review --base`. Inspect the backlog with `diffowl findings` and record fix, dismiss, or defer there. Treat findings as candidates. Do not edit review markdown.",
].join("\n");

export type DetectedAgentClients = {
  claude: boolean;
  cursor: boolean;
};

export type AgentPathHookResult =
  | { kind: "claude"; action: "installed" | "updated"; settingsPath: string }
  | { kind: "skipped" };

export type AgentPathInstructionResult =
  | { kind: "created"; path: string }
  | { kind: "updated"; path: string };

export type AgentPathResult = {
  clients: DetectedAgentClients;
  hook: AgentPathHookResult;
  instruction: AgentPathInstructionResult;
};

export function detectAgentClients(input: {
  projectRoot: string;
  env: NodeJS.Dict<string | undefined>;
}): DetectedAgentClients {
  return {
    claude:
      existsSync(join(input.projectRoot, ".claude")) ||
      existsSync(join(input.projectRoot, "CLAUDE.md")) ||
      envFlagEnabled(input.env["CLAUDECODE"]) ||
      envFlagEnabled(input.env["CLAUDE_CODE"]),
    cursor: existsSync(join(input.projectRoot, ".cursor")),
  };
}

export async function enableAgentPath(input: {
  projectRoot: string;
  env?: NodeJS.Dict<string | undefined>;
}): Promise<AgentPathResult> {
  const clients = detectAgentClients({
    projectRoot: input.projectRoot,
    env: input.env ?? {},
  });
  const instruction = await upsertAgentInstruction(input.projectRoot);
  if (!clients.claude) {
    return { clients, hook: { kind: "skipped" }, instruction };
  }

  const hook = await installClaudeCodeHook(input.projectRoot);
  return {
    clients,
    hook: { kind: "claude", action: hook.action, settingsPath: hook.settingsPath },
    instruction,
  };
}

export function agentsMarkdownPath(projectRoot: string): string {
  return join(projectRoot, "AGENTS.md");
}

function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const normalized = value.toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

async function upsertAgentInstruction(projectRoot: string): Promise<AgentPathInstructionResult> {
  const path = agentsMarkdownPath(projectRoot);
  const existing = await readOptionalFile(path);
  const next = mergeAgentInstruction(existing);
  await writeFileAtomic(path, next.content);
  return { kind: next.kind, path };
}

function mergeAgentInstruction(existing: string | null): {
  content: string;
  kind: AgentPathInstructionResult["kind"];
} {
  const block = renderInstructionBlock();
  if (existing === null) {
    return { content: block, kind: "created" };
  }
  if (existing.trim() === "") {
    return { content: block, kind: "updated" };
  }

  const start = existing.indexOf(AGENT_PATH_INSTRUCTION_START);
  if (start !== -1) {
    const end = existing.indexOf(AGENT_PATH_INSTRUCTION_END, start);
    const before = existing.slice(0, start);
    const after =
      end === -1 ? "" : existing.slice(end + AGENT_PATH_INSTRUCTION_END.length).replace(/^\n/, "");
    return { content: ensureTrailingNewline(`${before}${block}${after}`), kind: "updated" };
  }

  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  const separated = prefix.endsWith("\n\n") ? prefix : `${prefix}\n`;
  return { content: `${separated}${block}`, kind: "updated" };
}

function renderInstructionBlock(): string {
  return `${AGENT_PATH_INSTRUCTION_START}\n${AGENT_PATH_INSTRUCTION}\n${AGENT_PATH_INSTRUCTION_END}\n`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
