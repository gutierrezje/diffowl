import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { removeTempDir } from "../test/helpers.js";
import {
  buildClaudeSessionStartEntry,
  ClaudeCodeSettingsError,
  CLAUDE_HOOK_ARGS_SIGNATURE,
  installClaudeCodeHook,
} from "./claude-code.js";

const ClaudeHookEntrySchema = z.object({
  type: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});
const ClaudeMatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(ClaudeHookEntrySchema),
});
const ParsedSettingsSchema = z.object({
  permissions: z.json().optional(),
  hooks: z
    .object({
      PreToolUse: z.json().optional(),
      SessionStart: z.json().optional(),
    })
    .optional(),
});

type ClaudeHookEntry = z.output<typeof ClaudeHookEntrySchema>;
type ClaudeMatcherGroup = z.output<typeof ClaudeMatcherGroupSchema>;
type ClaudeHookFixture = z.input<typeof ClaudeHookEntrySchema>;
type ClaudeMatcherGroupFixture = {
  matcher?: string;
  hooks: ClaudeHookFixture[];
};
type SettingsFixture = {
  permissions?: { allow: string[] };
  hooks: {
    PreToolUse?: ClaudeMatcherGroupFixture[];
    SessionStart?: ClaudeMatcherGroupFixture[];
  };
};

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
  tempDirs = [];
});

describe("installClaudeCodeHook", () => {
  it("creates project settings with one startup|resume SessionStart group", async () => {
    const project = await createProject("diffowl-claude-fresh-");

    const result = await installClaudeCodeHook(project);

    expect(result).toEqual({
      settingsPath: join(project, ".claude", "settings.json"),
      action: "installed",
    });
    const groups = await readSessionStartGroups(project);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe("startup|resume");
    expect(groups[0]!.hooks).toHaveLength(1);
    const entry = groups[0]!.hooks[0]!;
    const args = entry.args ?? [];
    expect(entry.type).toBe("command");
    expect(entry.command).toBe(process.execPath);
    expect(args.slice(1)).toEqual([...CLAUDE_HOOK_ARGS_SIGNATURE]);
    expect(isAbsolute(args[0]!)).toBe(true);
    await expect(readFile(join(project, ".claude", "settings.json"), "utf-8")).resolves.toMatch(
      /\n$/,
    );
  });

  it("preserves unrelated settings and appends only the DiffOwl entry", async () => {
    const project = await createProject("diffowl-claude-merge-");
    const original = {
      permissions: { allow: ["Bash(git status:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo other" }] }],
      },
    };
    await writeSettings(project, original);

    const result = await installClaudeCodeHook(project);

    expect(result.action).toBe("installed");
    const settings = await readSettings(project);
    expect(settings.permissions).toEqual(original.permissions);
    expect(settings.hooks?.PreToolUse).toEqual(original.hooks.PreToolUse);
    const groups = await readSessionStartGroups(project);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(original.hooks.SessionStart[0]);
    expect(groups[1]!.matcher).toBe("startup|resume");
  });

  it("replaces an existing DiffOwl entry whose pinned paths are stale", async () => {
    const project = await createProject("diffowl-claude-stale-");
    const stale = buildClaudeSessionStartEntry({
      diffowl: "/old/bin/diffowl",
      node: "/old/node/v20/bin/node",
      cli: "/old/lib/diffowl/dist/cli.js",
      pathDirs: [],
    });
    await writeSettings(project, {
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "echo other" }] },
          { matcher: "startup|resume", hooks: [stale] },
        ],
      },
    });

    const result = await installClaudeCodeHook(project);

    expect(result.action).toBe("updated");
    const groups = await readSessionStartGroups(project);
    expect(groups).toHaveLength(2);
    const managed = groups.flatMap((group) => group.hooks).filter(isManagedEntry);
    expect(managed).toHaveLength(1);
    expect(managed[0]!.command).toBe(process.execPath);
    expect(managed[0]!.args?.[0]).not.toBe("/old/lib/diffowl/dist/cli.js");
    expect(groups[0]!.hooks[0]!.command).toBe("echo other");
  });

  it("is idempotent across repeated installs", async () => {
    const project = await createProject("diffowl-claude-idempotent-");

    const first = await installClaudeCodeHook(project);
    const afterFirst = await readFile(join(project, ".claude", "settings.json"), "utf-8");
    const second = await installClaudeCodeHook(project);
    const afterSecond = await readFile(join(project, ".claude", "settings.json"), "utf-8");

    expect(first.action).toBe("installed");
    expect(second.action).toBe("updated");
    expect(afterSecond).toBe(afterFirst);
    const groups = await readSessionStartGroups(project);
    expect(groups.flatMap((group) => group.hooks).filter(isManagedEntry)).toHaveLength(1);
  });

  it.each([
    { label: "invalid JSON", content: '{ "hooks": ' },
    { label: "a non-object hooks container", content: '{ "hooks": [] }' },
    { label: "a non-array SessionStart container", content: '{ "hooks": { "SessionStart": {} } }' },
  ])("rejects $label without writing", async ({ content }) => {
    const project = await createProject("diffowl-claude-malformed-");
    const settingsPath = join(project, ".claude", "settings.json");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(settingsPath, content, "utf-8");

    const installation = installClaudeCodeHook(project);

    await expect(installation).rejects.toBeInstanceOf(ClaudeCodeSettingsError);
    await expect(installation).rejects.toThrow(settingsPath);
    await expect(readFile(settingsPath, "utf-8")).resolves.toBe(content);
  });

  it("runs the installed entry directly, without a shell, from a path containing spaces", async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), "diffowl claude exec-"));
    tempDirs.push(scriptDir);
    const script = join(scriptDir, "print args.mjs");
    await writeFile(
      script,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      "utf-8",
    );
    const entry = buildClaudeSessionStartEntry({
      diffowl: "diffowl",
      node: process.execPath,
      cli: script,
      pathDirs: [],
    });

    const { stdout } = await execa(entry.command, entry.args);

    expect(JSON.parse(stdout)).toEqual([...CLAUDE_HOOK_ARGS_SIGNATURE]);
    // The executable and every argument stay separate argv values: no shell wrapper, no quoting.
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([script, ...CLAUDE_HOOK_ARGS_SIGNATURE]);
    expect(basename(entry.command)).not.toMatch(/^(sh|bash|zsh|cmd\.exe|powershell\.exe)$/);
    expect(entry.args).not.toContain("-c");
    expect(entry.args.filter((arg) => /['"]/.test(arg))).toEqual([]);
  });
});

describe("installClaudeCodeHook matcher normalization", () => {
  it("re-homes an adopted entry whose group matcher does not cover resume", async () => {
    const project = await createProject("diffowl-claude-narrow-matcher-");
    await writeSettings(project, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "/usr/bin/node",
                args: ["/old/cli.js", ...CLAUDE_HOOK_ARGS_SIGNATURE],
              },
            ],
          },
        ],
      },
    });

    await installClaudeCodeHook(project);

    const groups = await readSessionStartGroups(project);
    // The adopted entry must not stay under "startup": it would never fire on resume.
    const managed = groups.flatMap((group) =>
      group.hooks.filter(isManagedEntry).map((entry) => ({ matcher: group.matcher, entry })),
    );
    expect(managed).toHaveLength(1);
    expect(managed[0]!.matcher).toBe("startup|resume");
    expect(managed[0]!.entry.command).toBe(process.execPath);
    // The now-empty narrow group is pruned rather than left behind.
    expect(groups).toHaveLength(1);
  });

  it("preserves unrelated hooks in a narrow group while re-homing the managed entry", async () => {
    const project = await createProject("diffowl-claude-narrow-shared-");
    const unrelated = { type: "command", command: "/bin/echo", args: ["hi"] };
    await writeSettings(project, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              unrelated,
              {
                type: "command",
                command: "/usr/bin/node",
                args: ["/old/cli.js", ...CLAUDE_HOOK_ARGS_SIGNATURE],
              },
            ],
          },
        ],
      },
    });

    await installClaudeCodeHook(project);

    const groups = await readSessionStartGroups(project);
    const narrow = groups.find((group) => group.matcher === "startup");
    expect(narrow?.hooks).toEqual([unrelated]);
    const canonical = groups.find((group) => group.matcher === "startup|resume");
    expect(canonical?.hooks.filter(isManagedEntry)).toHaveLength(1);
  });

  it("replaces in place when the group matcher is already canonical", async () => {
    const project = await createProject("diffowl-claude-canonical-");
    await writeSettings(project, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume",
            hooks: [
              {
                type: "command",
                command: "/usr/bin/node",
                args: ["/old/cli.js", ...CLAUDE_HOOK_ARGS_SIGNATURE],
              },
            ],
          },
        ],
      },
    });

    const result = await installClaudeCodeHook(project);

    expect(result.action).toBe("updated");
    const groups = await readSessionStartGroups(project);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks).toHaveLength(1);
    expect(groups[0]!.hooks[0]!.command).toBe(process.execPath);
  });

  it("collapses pre-existing duplicate managed entries into one", async () => {
    const project = await createProject("diffowl-claude-duplicates-");
    // The state the previous implementation could not recover from: it returned at the first
    // managed entry, so the second survived every reinstall and both fired on every session start.
    await writeSettings(project, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume",
            hooks: [
              { type: "command", command: "/old/node", args: [...CLAUDE_HOOK_ARGS_SIGNATURE] },
            ],
          },
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "/older/node", args: [...CLAUDE_HOOK_ARGS_SIGNATURE] },
            ],
          },
        ],
      },
    });

    const result = await installClaudeCodeHook(project);

    expect(result.action).toBe("updated");
    const groups = await readSessionStartGroups(project);
    const managed = groups.flatMap((group) => group.hooks.filter(isManagedEntry));
    expect(managed).toHaveLength(1);
    expect(managed[0]!.command).toBe(process.execPath);
    // The narrow "startup" group held nothing else, so it is pruned rather than left empty.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe("startup|resume");
  });

  it("preserves unrelated hooks when pruning a duplicate out of their group", async () => {
    const project = await createProject("diffowl-claude-unrelated-");
    await writeSettings(project, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "/usr/bin/other", args: ["unrelated", "tool"] },
              { type: "command", command: "/old/node", args: [...CLAUDE_HOOK_ARGS_SIGNATURE] },
            ],
          },
        ],
      },
    });

    await installClaudeCodeHook(project);

    const groups = await readSessionStartGroups(project);
    const narrow = groups.find((group) => group.matcher === "startup");
    expect(narrow?.hooks).toHaveLength(1);
    expect(narrow?.hooks[0]!.command).toBe("/usr/bin/other");
    expect(groups.flatMap((group) => group.hooks.filter(isManagedEntry))).toHaveLength(1);
  });

  it("leaves no temp file beside the settings it rewrote", async () => {
    const project = await createProject("diffowl-claude-atomic-");
    await writeSettings(project, { hooks: {} });

    await installClaudeCodeHook(project);

    const entries = await readdir(join(project, ".claude"));
    expect(entries).toEqual(["settings.json"]);
  });
});

function isManagedEntry(entry: ClaudeHookEntry): boolean {
  const signature = [...CLAUDE_HOOK_ARGS_SIGNATURE];
  const args = entry.args ?? [];
  return args.slice(-signature.length).join(" ") === signature.join(" ");
}

async function createProject(prefix: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(project);
  return project;
}

async function writeSettings(project: string, settings: SettingsFixture): Promise<void> {
  await mkdir(join(project, ".claude"), { recursive: true });
  await writeFile(
    join(project, ".claude", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf-8",
  );
}

async function readSettings(project: string) {
  const content = await readFile(join(project, ".claude", "settings.json"), "utf-8");
  return ParsedSettingsSchema.parse(JSON.parse(content));
}

async function readSessionStartGroups(project: string): Promise<ClaudeMatcherGroup[]> {
  const settings = await readSettings(project);
  return z.array(ClaudeMatcherGroupSchema).parse(settings.hooks?.SessionStart ?? []);
}
