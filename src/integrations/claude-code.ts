import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { getHookCommand } from "../git/hooks.js";

/**
 * Claude Code integration adapter.
 *
 * Everything Claude-specific — the settings path, the hook schema, the matcher, the managed
 * identity, and the merge — lives here (D-19). The CLI only selects a client and delegates, and
 * the finding computation it invokes stays client-neutral.
 */

/**
 * Stable managed identity for the installed entry (D-14). Absolute executable paths are not:
 * D-15 pins them, so they differ per machine and change when Node is upgraded. Matching the
 * argument suffix also lets an equivalent hand-written DiffOwl entry be adopted and updated.
 */
export const CLAUDE_HOOK_ARGS_SIGNATURE = ["findings", "summary", "--format", "text"] as const;

const SESSION_START_MATCHER = "startup|resume";

/**
 * Claude's hook timeout is expressed in seconds. This is only an external backstop; the short
 * internal bound on the summary query is owned separately (D-17).
 */
const HOOK_TIMEOUT_SECONDS = 5;

const JsonValueSchema = z.json();
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const JsonArraySchema = z.array(JsonValueSchema);
const ClaudeSessionStartGroupSchema = z
  .object({ hooks: JsonArraySchema })
  .catchall(JsonValueSchema);
const ClaudeHookCandidateSchema = z.object({ args: JsonArraySchema }).catchall(JsonValueSchema);

type HookCommand = Awaited<ReturnType<typeof getHookCommand>>;
type JsonValue = z.output<typeof JsonValueSchema>;
type JsonObject = z.output<typeof JsonObjectSchema>;
type JsonArray = z.output<typeof JsonArraySchema>;
type ClaudeSessionStartGroup = z.output<typeof ClaudeSessionStartGroupSchema>;

export class ClaudeCodeSettingsError extends Error {
  override name = "ClaudeCodeSettingsError";
}

export interface ClaudeSessionStartEntry {
  type: "command";
  command: string;
  args: string[];
  timeout: number;
}

export interface ClaudeCodeHookInstallResult {
  settingsPath: string;
  action: "installed" | "updated";
}

/**
 * Build the SessionStart hook in Claude's direct exec form: the pinned Node executable is the
 * command and the pinned CLI path is the first argument (D-15). No shell parses these values, so
 * spaces and quotes stay literal argv data on every platform.
 */
export function buildClaudeSessionStartEntry(command: HookCommand): ClaudeSessionStartEntry {
  return {
    type: "command",
    command: command.node,
    args: [command.cli, ...CLAUDE_HOOK_ARGS_SIGNATURE],
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

/**
 * Merge the DiffOwl SessionStart entry into the project's `.claude/settings.json` (D-14). Never
 * the user-global file and never `settings.local.json`: the findings live in this repo, so the
 * hook belongs to this repo. The file is user-owned and hand-editable, so this is an idempotent
 * merge that fails closed — malformed input is rejected before anything is written.
 */
export async function installClaudeCodeHook(
  cwd: string = process.cwd(),
): Promise<ClaudeCodeHookInstallResult> {
  const settingsPath = join(resolve(cwd), ".claude", "settings.json");
  const settings = await readSettings(settingsPath);
  const hooks = requireHooksContainer(settings, settingsPath);
  const sessionStart = requireSessionStartContainer(hooks, settingsPath);

  const entry = buildClaudeSessionStartEntry(await getHookCommand());
  const action = reconcileManagedEntries(sessionStart, JsonValueSchema.parse(entry));

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeSettingsAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { settingsPath, action };
}

/**
 * `settings.json` is user-owned and hand-edited, and this function rewrites it wholesale. Writing
 * in place truncates first, so an interrupted write — a crash, a full disk, a killed terminal —
 * leaves the user with a truncated or empty settings file rather than the one they wrote. Renaming
 * over the target is atomic on POSIX, so a reader sees either the old file or the new one.
 *
 * The temp file is deliberately a sibling: rename is only atomic within a filesystem, and a temp
 * directory can be on a different one.
 */
async function writeSettingsAtomic(settingsPath: string, content: string): Promise<void> {
  const tempPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  try {
    await rename(tempPath, settingsPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readSettings(settingsPath: string): Promise<JsonObject> {
  let content: string;
  try {
    content = await readFile(settingsPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && isMissingFileError(error)) return {};
    const failure = error instanceof Error ? error : new Error(String(error));
    throw new ClaudeCodeSettingsError(`Could not read ${settingsPath}: ${failure.message}`);
  }

  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      throw new ClaudeCodeSettingsError(`Expected a JSON object in ${settingsPath}.`);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ClaudeCodeSettingsError) throw error;
    const failure = error instanceof Error ? error : new Error(String(error));
    throw new ClaudeCodeSettingsError(`Could not parse ${settingsPath}: ${failure.message}`);
  }
}

function requireHooksContainer(settings: JsonObject, settingsPath: string): JsonObject {
  const hooks = settings["hooks"];
  if (hooks === undefined) {
    const created: JsonObject = {};
    settings["hooks"] = created;
    return created;
  }
  const parsed = JsonObjectSchema.safeParse(hooks);
  if (!parsed.success) {
    throw new ClaudeCodeSettingsError(`Expected "hooks" to be an object in ${settingsPath}.`);
  }
  settings["hooks"] = parsed.data;
  return parsed.data;
}

function requireSessionStartContainer(hooks: JsonObject, settingsPath: string): JsonArray {
  const sessionStart = hooks["SessionStart"];
  if (sessionStart === undefined) {
    const created: JsonArray = [];
    hooks["SessionStart"] = created;
    return created;
  }
  const parsed = JsonArraySchema.safeParse(sessionStart);
  if (!parsed.success) {
    throw new ClaudeCodeSettingsError(
      `Expected "hooks.SessionStart" to be an array in ${settingsPath}.`,
    );
  }
  hooks["SessionStart"] = parsed.data;
  return parsed.data;
}

/**
 * Converge `SessionStart` on exactly one managed DiffOwl entry, under the canonical matcher.
 *
 * Identity is the argument suffix, so an adopted hand-written entry can be sitting under a narrower
 * matcher than the canonical one (e.g. "startup"). Leaving such an entry in place would leave a
 * hook that silently never fires on resume, so every managed entry is stripped wherever it sits and
 * one canonical entry is placed afterwards. Matcher groups DiffOwl does not recognize are otherwise
 * untouched: unrelated hooks are left alone, and a group is pruned only if removing our entry
 * empties it.
 *
 * Sweeping every group rather than returning at the first match is what makes this idempotent. The
 * previous version stopped at the first managed entry, so a settings file that had accumulated two
 * — a hand-written one plus an installed one, or the residue of an interrupted re-home — kept the
 * duplicate forever, and both entries fired on every session start. Reinstalling is the operation
 * users reach for to fix a broken hook, so it has to converge rather than preserve the mess.
 */
function reconcileManagedEntries(
  sessionStart: JsonArray,
  entry: JsonValue,
): ClaudeCodeHookInstallResult["action"] {
  let existed = false;
  let canonicalGroup: ClaudeSessionStartGroup | null = null;

  // Reverse order so splicing a drained group cannot skip the next one.
  for (let groupIndex = sessionStart.length - 1; groupIndex >= 0; groupIndex--) {
    const parsed = ClaudeSessionStartGroupSchema.safeParse(sessionStart[groupIndex]);
    if (!parsed.success) continue;
    const group = parsed.data;
    const groupHooks = group.hooks;
    sessionStart[groupIndex] = group;

    for (let hookIndex = groupHooks.length - 1; hookIndex >= 0; hookIndex--) {
      const hook = groupHooks[hookIndex];
      if (hook === undefined || !isManagedEntry(hook)) continue;
      groupHooks.splice(hookIndex, 1);
      existed = true;
    }

    if (groupHooks.length === 0) {
      sessionStart.splice(groupIndex, 1);
      continue;
    }
    // Assigned on the way down, so the surviving canonical group closest to the top wins and the
    // entry lands where a reader would look for it.
    if (group["matcher"] === SESSION_START_MATCHER) {
      canonicalGroup = group;
    }
  }

  if (canonicalGroup) {
    canonicalGroup.hooks.push(entry);
  } else {
    sessionStart.push({ matcher: SESSION_START_MATCHER, hooks: [entry] });
  }

  return existed ? "updated" : "installed";
}

function isManagedEntry(hook: JsonValue): boolean {
  const parsed = ClaudeHookCandidateSchema.safeParse(hook);
  if (!parsed.success || parsed.data.args.length < CLAUDE_HOOK_ARGS_SIGNATURE.length) return false;
  const args = parsed.data.args;
  const suffix = args.slice(-CLAUDE_HOOK_ARGS_SIGNATURE.length);
  return CLAUDE_HOOK_ARGS_SIGNATURE.every((value, index) => suffix[index] === value);
}

function isMissingFileError(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}
