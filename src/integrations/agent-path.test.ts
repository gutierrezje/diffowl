import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  AGENT_PATH_INSTRUCTION,
  AGENT_PATH_INSTRUCTION_END,
  AGENT_PATH_INSTRUCTION_START,
  agentsMarkdownPath,
  detectAgentClients,
  enableAgentPath,
} from "./agent-path.js";
import { CLAUDE_HOOK_ARGS_SIGNATURE } from "./claude-code.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-agent-path-"));
  tempDirs.push(root);
  return root;
}

describe("detectAgentClients", () => {
  it("is unknown in an empty project", async () => {
    const projectRoot = await makeProject();
    expect(detectAgentClients({ projectRoot, env: {} })).toEqual({ claude: false, cursor: false });
  });

  it("detects Claude Code from CLAUDE.md", async () => {
    const projectRoot = await makeProject();
    await writeFile(join(projectRoot, "CLAUDE.md"), "# Claude\n", "utf-8");
    expect(detectAgentClients({ projectRoot, env: {} }).claude).toBe(true);
  });

  it("detects Claude Code from a .claude directory", async () => {
    const projectRoot = await makeProject();
    await mkdir(join(projectRoot, ".claude"));
    expect(detectAgentClients({ projectRoot, env: {} }).claude).toBe(true);
  });

  it("detects Claude Code from CLAUDECODE", async () => {
    const projectRoot = await makeProject();
    expect(detectAgentClients({ projectRoot, env: { CLAUDECODE: "1" } }).claude).toBe(true);
    expect(detectAgentClients({ projectRoot, env: { CLAUDECODE: "0" } }).claude).toBe(false);
  });

  it("detects Cursor from a .cursor directory", async () => {
    const projectRoot = await makeProject();
    await mkdir(join(projectRoot, ".cursor"));
    expect(detectAgentClients({ projectRoot, env: {} })).toEqual({ claude: false, cursor: true });
  });
});

describe("enableAgentPath", () => {
  it("writes AGENTS.md and skips the Claude hook when no client is detected", async () => {
    const projectRoot = await makeProject();

    const result = await enableAgentPath({ projectRoot, env: {} });

    expect(result.clients).toEqual({ claude: false, cursor: false });
    expect(result.hook).toEqual({ kind: "skipped" });
    expect(result.instruction).toEqual({
      kind: "created",
      path: agentsMarkdownPath(projectRoot),
    });
    const markdown = await readFile(result.instruction.path, "utf-8");
    expect(markdown).toContain(AGENT_PATH_INSTRUCTION_START);
    expect(markdown).toContain("`diffowl review --base`");
    expect(markdown).toContain("`diffowl findings`");
    expect(markdown).toContain(AGENT_PATH_INSTRUCTION_END);
    expect(markdown).not.toContain(AGENT_PATH_INSTRUCTION_START + AGENT_PATH_INSTRUCTION_START);
    await expect(readFile(join(projectRoot, ".claude", "settings.json"), "utf-8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("appends a managed block to an existing AGENTS.md", async () => {
    const projectRoot = await makeProject();
    const path = agentsMarkdownPath(projectRoot);
    await writeFile(path, "# House rules\n\nDo not skip tests.\n", "utf-8");

    const result = await enableAgentPath({ projectRoot, env: {} });

    expect(result.instruction.kind).toBe("updated");
    const markdown = await readFile(path, "utf-8");
    expect(markdown.startsWith("# House rules\n\nDo not skip tests.\n")).toBe(true);
    expect(markdown).toContain(AGENT_PATH_INSTRUCTION);
  });

  it("replaces an existing managed block instead of duplicating it", async () => {
    const projectRoot = await makeProject();
    const path = agentsMarkdownPath(projectRoot);
    await writeFile(
      path,
      [
        "# House rules",
        "",
        AGENT_PATH_INSTRUCTION_START,
        "## DiffOwl",
        "",
        "stale pointer",
        AGENT_PATH_INSTRUCTION_END,
        "",
        "Keep going.",
        "",
      ].join("\n"),
      "utf-8",
    );

    await enableAgentPath({ projectRoot, env: {} });
    const first = await readFile(path, "utf-8");
    await enableAgentPath({ projectRoot, env: {} });
    const second = await readFile(path, "utf-8");

    expect(first).toBe(second);
    expect(first.match(new RegExp(AGENT_PATH_INSTRUCTION_START, "g"))).toHaveLength(1);
    expect(first).toContain("`diffowl review --base`");
    expect(first).toContain("Keep going.");
    expect(first).not.toContain("stale pointer");
  });

  it("installs the Claude session hook when Claude Code is detected", async () => {
    const projectRoot = await makeProject();
    await writeFile(join(projectRoot, "CLAUDE.md"), "# Claude\n", "utf-8");

    const result = await enableAgentPath({ projectRoot, env: {} });

    expect(result.hook).toMatchObject({ kind: "claude", action: "installed" });
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: { SessionStart: { hooks: { args: string[] }[] }[] };
    };
    const args = settings.hooks.SessionStart[0]?.hooks[0]?.args ?? [];
    expect(args.slice(-CLAUDE_HOOK_ARGS_SIGNATURE.length)).toEqual([...CLAUDE_HOOK_ARGS_SIGNATURE]);
  });

  it("skips the Claude hook for a Cursor-only project", async () => {
    const projectRoot = await makeProject();
    await mkdir(join(projectRoot, ".cursor"));

    const result = await enableAgentPath({ projectRoot, env: {} });

    expect(result.clients.cursor).toBe(true);
    expect(result.hook).toEqual({ kind: "skipped" });
    await expect(readFile(join(projectRoot, ".claude", "settings.json"), "utf-8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("writes AGENTS.md before failing on malformed Claude settings", async () => {
    const projectRoot = await makeProject();
    await mkdir(join(projectRoot, ".claude"));
    await writeFile(join(projectRoot, ".claude", "settings.json"), "{not json", "utf-8");

    await expect(enableAgentPath({ projectRoot, env: {} })).rejects.toThrow(/parse/);
    const markdown = await readFile(agentsMarkdownPath(projectRoot), "utf-8");
    expect(markdown).toContain("`diffowl review --base`");
  });
});
