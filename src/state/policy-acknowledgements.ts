import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const PolicyChangeSchema = z.object({
  // An unparseable base config is acknowledged under a tagged identity instead of a policy hash.
  base_policy_sha256: z.string().regex(/^(invalid:)?[0-9a-f]{64}$/),
  branch_policy_sha256: Sha256Schema,
}).strict();
const FileSchema = z.object({
  version: z.literal(1),
  acknowledgements: z.array(PolicyChangeSchema.extend({ acknowledged_at: z.string() }).strict()),
}).strict();

/**
 * The decision a human accepted: the base's policy and the branch's different policy. The base
 * commit is deliberately not part of the key, so fetches that move the base keep the decision.
 */
export type PolicyChangeTuple = z.output<typeof PolicyChangeSchema>;

const FILENAME = "policy-acknowledgements.json";

/** Read-only; a missing file means nothing was acknowledged. A malformed file is an error, never "none". */
export async function isPolicyChangeAcknowledged(stateDir: string, change: PolicyChangeTuple): Promise<boolean> {
  return includesChange(await readFileContent(stateDir), change);
}

export async function recordPolicyAcknowledgement(stateDir: string, change: PolicyChangeTuple): Promise<void> {
  const content = await readFileContent(stateDir);
  if (includesChange(content, change)) return;
  content.acknowledgements.push({
    base_policy_sha256: change.base_policy_sha256,
    branch_policy_sha256: change.branch_policy_sha256,
    acknowledged_at: new Date().toISOString(),
  });
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, FILENAME);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`, "utf-8");
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function includesChange(content: z.output<typeof FileSchema>, change: PolicyChangeTuple): boolean {
  return content.acknowledgements.some(entry =>
    entry.base_policy_sha256 === change.base_policy_sha256 &&
    entry.branch_policy_sha256 === change.branch_policy_sha256);
}

async function readFileContent(stateDir: string): Promise<z.output<typeof FileSchema>> {
  const path = join(stateDir, FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: 1, acknowledgements: [] };
    }
    throw error;
  }
  try {
    return FileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Malformed ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
