import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../test/helpers.js";
import { isPolicyChangeAcknowledged, recordPolicyAcknowledgement } from "./policy-acknowledgements.js";

describe("policy acknowledgements", () => {
  let root: string;
  let dir: string;
  const change = { base_policy_sha256: "b".repeat(64), branch_policy_sha256: "c".repeat(64) };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "diffowl-policy-ack-"));
    dir = join(root, "state");
  });
  afterEach(async () => { await removeTempDir(root); });

  it("matches only the exact base policy and branch policy pair", async () => {
    expect(await isPolicyChangeAcknowledged(dir, change)).toBe(false);
    await recordPolicyAcknowledgement(dir, change);
    expect(await isPolicyChangeAcknowledged(dir, change)).toBe(true);
    for (const other of [
      { ...change, base_policy_sha256: "d".repeat(64) },
      { ...change, branch_policy_sha256: "d".repeat(64) },
    ]) expect(await isPolicyChangeAcknowledged(dir, other)).toBe(false);
  });

  it("stores only the policy pair and a timestamp, and records an identical pair once", async () => {
    await recordPolicyAcknowledgement(dir, change);
    const first = await readFile(join(dir, "policy-acknowledgements.json"), "utf8");
    expect(JSON.parse(first).acknowledgements).toEqual([{ ...change, acknowledged_at: expect.any(String) }]);
    await recordPolicyAcknowledgement(dir, change);
    expect(await readFile(join(dir, "policy-acknowledgements.json"), "utf8")).toBe(first);
  });

  it("acknowledges an unparseable base under its tagged identity", async () => {
    const invalid = { ...change, base_policy_sha256: `invalid:${"e".repeat(64)}` };
    await recordPolicyAcknowledgement(dir, invalid);
    expect(await isPolicyChangeAcknowledged(dir, invalid)).toBe(true);
    expect(await isPolicyChangeAcknowledged(dir, { ...invalid, base_policy_sha256: "e".repeat(64) })).toBe(false);
  });

  it("treats a malformed file as an error rather than no acknowledgement", async () => {
    await recordPolicyAcknowledgement(dir, change);
    await writeFile(join(dir, "policy-acknowledgements.json"), "{ not json");
    await expect(isPolicyChangeAcknowledged(dir, change)).rejects.toThrow(/Malformed/);
  });
});
