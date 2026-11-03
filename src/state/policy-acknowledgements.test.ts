import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { isPolicyChangeAcknowledged, recordPolicyAcknowledgement } from "./policy-acknowledgements.js";

describe("policy acknowledgements", () => {
  let root: string;
  let dir: string;
  const change = { base_commit: "a".repeat(40), base_policy_sha256: "b".repeat(64), branch_policy_sha256: "c".repeat(64) };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "diffowl-policy-ack-"));
    dir = join(root, "state");
  });
  afterEach(async () => { await removeTempDir(root); });

  it("matches only the exact base commit, base policy, and branch policy", async () => {
    expect(await isPolicyChangeAcknowledged(dir, change)).toBe(false);
    await recordPolicyAcknowledgement(dir, change, "2026-11-02T00:00:00.000Z");
    expect(await isPolicyChangeAcknowledged(dir, change)).toBe(true);
    for (const other of [
      { ...change, base_commit: "d".repeat(40) },
      { ...change, base_policy_sha256: "d".repeat(64) },
      { ...change, branch_policy_sha256: "d".repeat(64) },
    ]) expect(await isPolicyChangeAcknowledged(dir, other)).toBe(false);
  });

  it("records an identical acknowledgement once", async () => {
    await recordPolicyAcknowledgement(dir, change, "2026-11-02T00:00:00.000Z");
    const first = await readFile(join(dir, "policy-acknowledgements.json"), "utf8");
    await recordPolicyAcknowledgement(dir, change, "2026-11-03T00:00:00.000Z");
    expect(await readFile(join(dir, "policy-acknowledgements.json"), "utf8")).toBe(first);
  });

  it("treats a malformed file as an error rather than no acknowledgement", async () => {
    await recordPolicyAcknowledgement(dir, change, "2026-11-02T00:00:00.000Z");
    await writeFile(join(dir, "policy-acknowledgements.json"), "{ not json");
    await expect(isPolicyChangeAcknowledged(dir, change)).rejects.toThrow(/Malformed/);
  });
});
