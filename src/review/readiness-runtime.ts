import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const MarkerSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40,64}$/), queuedAt: z.string(), attemptedAt: z.string().optional() });
const ResultSchema = z.object({ exitCode: z.number().int(), timestamp: z.string(), commit: z.string().optional() });
const ActiveSchema = z.object({ sha: z.string(), pid: z.number().int().positive() });
interface ReadinessQueue {
  pending: string[];
  failed: string[];
  identity: (string | null)[];
}

/** Unlike hook queue processing, readiness never removes files or hides unreadable markers. */
export async function readReadinessQueue(projectRoot: string) {
  const local = join(projectRoot, ".diffowl");
  const directory = join(local, "pending-reviews");
  const activeText = await optionalText(join(local, "active-hook-review.json"));
  const lockText = await optionalText(join(local, "hook-review.lock"));
  const active = activeText === null ? null : ActiveSchema.parse(JSON.parse(activeText));
  if (lockText !== null && !/^[1-9]\d*$/.test(lockText.trim())) throw new Error("Invalid hook review lock.");
  let activeSha: string | null = null;
  if (active !== null && lockText !== null && Number(lockText.trim()) === active.pid) {
    try { process.kill(active.pid, 0); activeSha = active.sha; }
    catch (error) {
      const code = z.object({ code: z.string() }).parse(error).code;
      if (code === "EPERM") activeSha = active.sha;
      else if (code !== "ESRCH") throw error;
    }
  }
  const result: ReadinessQueue = {
    pending: [], failed: [], identity: [activeText, lockText],
  };
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return result;
    throw error;
  }
  for (const name of names.sort()) {
    if (name.endsWith(".result.json") || name.endsWith(".tmp")) continue;
    const text = await readFile(join(directory, name), "utf8");
    const marker = MarkerSchema.parse(JSON.parse(text));
    if (marker.sha !== name) throw new Error("Pending review marker does not match its commit filename.");
    const outcomeText = await optionalText(join(directory, `${name}.result.json`));
    const outcome = outcomeText === null ? null : ResultSchema.parse(JSON.parse(outcomeText));
    if (outcome?.commit !== undefined && outcome.commit !== marker.sha) throw new Error("Hook result belongs to a different commit.");
    result.identity.push(text, outcomeText);
    (outcome !== null && outcome.exitCode !== 0 && marker.sha !== activeSha ? result.failed : result.pending).push(marker.sha);
  }
  return result;
}

async function optionalText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return null;
    throw error;
  }
}
