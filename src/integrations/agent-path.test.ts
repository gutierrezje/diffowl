import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { rmSync } from "node:fs";
import {
  AGENT_PATH_INSTRUCTION,
  AGENT_PATH_INSTRUCTION_END,
  AGENT_PATH_INSTRUCTION_START,
  agentInstructionExists,
  agentsMarkdownPath,
  defaultInstallHook,
  defaultWriteInstruction,
  detectAgentClients,
  enableAgentPath,
  parseYesNo,
  yesNoPromptSuffix,
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

describe("parseYesNo", () => {
  it("treats empty input as the default", () => {
    expect(parseYesNo("", true)).toEqual({ kind: "yes" });
    expect(parseYesNo("  ", false)).toEqual({ kind: "no" });
  });

  it("accepts y/yes and n/no", () => {
    expect(parseYesNo("Y", false)).toEqual({ kind: "yes" });
    expect(parseYesNo("yes", false)).toEqual({ kind: "yes" });
    expect(parseYesNo("N", true)).toEqual({ kind: "no" });
    expect(parseYesNo("no", true)).toEqual({ kind: "no" });
  });

  it("rejects other answers", () => {
    expect(parseYesNo("maybe", true)).toEqual({ kind: "invalid" });
    expect(parseYesNo("1", false)).toEqual({ kind: "invalid" });
  });
});

describe("agent path prompt defaults", () => {
  it("defaults to writing instructions only when AGENTS.md is missing", () => {
    expect(defaultWriteInstruction(false)).toBe(true);
    expect(defaultWriteInstruction(true)).toBe(false);
    expect(yesNoPromptSuffix(true)).toBe("[Y/n]");
    expect(yesNoPromptSuffix(false)).toBe("[y/N]");
  });

  it("defaults to installing the hook only when Claude Code is detected", () => {
    expect(defaultInstallHook(true)).toBe(true);
    expect(defaultInstallHook(false)).toBe(false);
  });
});

describe("enableAgentPath", () => {
  it("writes AGENTS.md and skips the Claude hook when only instructions are accepted", async () => {
    const projectRoot = await makeProject();

    const result = await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: true,
      installHook: false,
    });

    expect(result.clients).toEqual({ claude: false, cursor: false });
    expect(result.hook).toEqual({ kind: "skipped" });
    expect(result.instruction).toEqual({
      kind: "created",
      path: agentsMarkdownPath(projectRoot),
    });
    const markdown = await readFile(agentsMarkdownPath(projectRoot), "utf-8");
    expect(markdown).toContain(AGENT_PATH_INSTRUCTION_START);
    expect(markdown).toContain("`diffowl review --base`");
    expect(markdown).toContain("`diffowl findings`");
    expect(markdown).toContain(AGENT_PATH_INSTRUCTION_END);
    await expect(
      readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes nothing when both prompts are declined", async () => {
    const projectRoot = await makeProject();
    await writeFile(join(projectRoot, "CLAUDE.md"), "# Claude\n", "utf-8");

    const result = await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: false,
      installHook: false,
    });

    expect(result.instruction).toEqual({ kind: "skipped" });
    expect(result.hook).toEqual({ kind: "skipped" });
    expect(agentInstructionExists(projectRoot)).toBe(false);
    await expect(
      readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends a managed block to an existing AGENTS.md", async () => {
    const projectRoot = await makeProject();
    const path = agentsMarkdownPath(projectRoot);
    await writeFile(path, "# House rules\n\nDo not skip tests.\n", "utf-8");

    const result = await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: true,
      installHook: false,
    });

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

    await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: true,
      installHook: false,
    });
    const first = await readFile(path, "utf-8");
    await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: true,
      installHook: false,
    });
    const second = await readFile(path, "utf-8");

    expect(first).toBe(second);
    expect(first.match(new RegExp(AGENT_PATH_INSTRUCTION_START, "g"))).toHaveLength(1);
    expect(first).toContain("`diffowl review --base`");
    expect(first).toContain("Keep going.");
    expect(first).not.toContain("stale pointer");
  });

  it("installs the Claude session hook when accepted, even without Claude markers", async () => {
    const projectRoot = await makeProject();

    const result = await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: false,
      installHook: true,
    });

    expect(result.instruction).toEqual({ kind: "skipped" });
    expect(result.hook).toMatchObject({ kind: "claude", action: "installed" });
    expect(agentInstructionExists(projectRoot)).toBe(false);
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    const settings = z
      .object({
        hooks: z.object({
          SessionStart: z.array(
            z.object({ hooks: z.array(z.object({ args: z.array(z.string()) })) }),
          ),
        }),
      })
      .parse(JSON.parse(await readFile(settingsPath, "utf-8")));
    const args = settings.hooks.SessionStart[0]?.hooks[0]?.args ?? [];
    expect(args.slice(-CLAUDE_HOOK_ARGS_SIGNATURE.length)).toEqual([...CLAUDE_HOOK_ARGS_SIGNATURE]);
  });

  it("skips the Claude hook when declined even if Claude Code is detected", async () => {
    const projectRoot = await makeProject();
    await mkdir(join(projectRoot, ".cursor"));
    await writeFile(join(projectRoot, "CLAUDE.md"), "# Claude\n", "utf-8");

    const result = await enableAgentPath({
      projectRoot,
      env: {},
      writeInstruction: true,
      installHook: false,
    });

    expect(result.clients).toEqual({ claude: true, cursor: true });
    expect(result.hook).toEqual({ kind: "skipped" });
    await expect(
      readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes AGENTS.md before failing on malformed Claude settings", async () => {
    const projectRoot = await makeProject();
    await mkdir(join(projectRoot, ".claude"));
    await writeFile(join(projectRoot, ".claude", "settings.json"), "{not json", "utf-8");

    await expect(
      enableAgentPath({
        projectRoot,
        env: {},
        writeInstruction: true,
        installHook: true,
      }),
    ).rejects.toThrow(/parse/);
    const markdown = await readFile(agentsMarkdownPath(projectRoot), "utf-8");
    expect(markdown).toContain("`diffowl review --base`");
  });
});
