import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseLegacyReceipt } from "./run-store.mjs";
import { digest, runCommand } from "./system.mjs";
import { captureSourceIdentity } from "./source-identity.mjs";

export async function inspectRunIdentity(run) {
  const { projectRoot, binaryPath, controllerPath } = run.manifest;
  const current = await captureRunIdentity({ projectRoot, binaryPath, controllerPath });
  let legacy = null;
  let receiptError = null;
  try {
    legacy = await parseLegacyReceipt(join(run.evidence, "receipt.txt"));
  } catch (error) {
    receiptError = error instanceof Error ? error.message : String(error);
  }
  return compareRunIdentity({ run, legacy, current, receiptError });
}

export async function captureRunIdentity({ projectRoot, binaryPath, controllerPath }) {
  const current = {
    source: null,
    controllerHash: null,
    binaryHash: null,
    errors: [],
  };
  try {
    current.source = await captureSourceIdentity(projectRoot);
  } catch (error) {
    current.errors.push({
      identity: "source content",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    current.controllerHash = digest(await readFile(controllerPath));
  } catch (error) {
    current.errors.push({
      identity: "controller artifact",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const artifact = await runCommand("git", ["-C", projectRoot, "hash-object", binaryPath], {
      cwd: projectRoot,
    });
    if (artifact.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(artifact.stdout)) {
      throw new Error(artifact.stderr || `git hash-object exited ${artifact.exitCode}`);
    }
    current.binaryHash = artifact.stdout;
  } catch (error) {
    current.errors.push({
      identity: "binary artifact",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return current;
}

function compareRunIdentity({ run, legacy, current, receiptError = null }) {
  const manifest = run.manifest;
  const problems = current.errors.map(
    ({ identity, error }) => `current ${identity} identity unavailable: ${error}`,
  );
  if (receiptError) problems.push(`recorded run identity unavailable: ${receiptError}`);
  const checks = [];
  const identities = [
    {
      check: "run source HEAD identity",
      expected: manifest.sourceIdentity?.head,
      observed: current.source?.head,
      unavailable: "run source HEAD identity unavailable",
      mismatch: "run source HEAD no longer matches checkout",
    },
    {
      check: "run source content identity",
      expected: manifest.sourceIdentity?.hash,
      observed: current.source?.hash,
      unavailable: "run source content identity unavailable",
      mismatch: "run source content identity no longer matches checkout",
    },
    {
      check: "run controller artifact identity",
      expected: manifest.controllerHash,
      observed: current.controllerHash,
      unavailable: "run controller artifact identity unavailable",
      mismatch: "run controller artifact no longer matches checkout",
    },
    {
      check: "run binary artifact identity",
      expected: legacy?.binary_hash,
      observed: current.binaryHash,
      unavailable: "run binary artifact identity unavailable",
      mismatch: "run artifact no longer matches current binary",
    },
  ];

  for (const identity of identities) {
    const { check, expected, observed, unavailable, mismatch } = identity;
    const hasExpected = Boolean(expected);
    const hasObserved = Boolean(observed);
    const ok = hasExpected && hasObserved && expected === observed;
    if (!hasExpected || !hasObserved) problems.push(unavailable);
    else if (!ok) problems.push(mismatch);
    checks.push({ check, ok, expected: expected ?? null, observed: observed ?? null });
  }

  if (!legacy?.source_head) {
    problems.push("run source HEAD identity unavailable");
  } else if (legacy.source_head !== manifest.sourceIdentity?.head) {
    problems.push("run source HEAD no longer matches checkout");
  }

  return {
    ok: problems.length === 0,
    problems,
    checks,
    current,
  };
}
