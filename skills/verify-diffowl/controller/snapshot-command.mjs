import { join } from "node:path";
import { ControllerError } from "./errors.mjs";
import {
  loadSurfaceRun,
  readReceipt,
  updateReceipt,
  writeJsonExclusive,
} from "./run-store.mjs";
import { captureState } from "./state.mjs";
import { pathExists } from "./system.mjs";

export async function snapshot(adapter, runIdInput, labelInput) {
  const run = await loadSurfaceRun(adapter, runIdInput, "snapshot");
  const label = labelInput ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new ControllerError({
      command: "snapshot",
      expected: "a filesystem-safe --label",
      observed: label,
      likelyCause: "The snapshot label contains unsupported characters.",
      nextAction: "Use letters, digits, dot, underscore, or dash.",
      exitCode: 2,
    });
  }
  if (!(await pathExists(run.manifest.scratch))) {
    throw new ControllerError({
      command: "snapshot",
      expected: "the run's disposable repository to exist",
      observed: "scratch already removed",
      likelyCause: "Cleanup ran before the requested observation.",
      nextAction: "Inspect retained snapshots or create a new run.",
    });
  }
  const state = await captureState(run);
  const artifact = join(run.evidence, "snapshots", `${label}.json`);
  const result = {
    schemaVersion: 1,
    command: "snapshot",
    success: true,
    surface: adapter.surface,
    runId: run.manifest.runId,
    observedTarget: { scratch: run.manifest.scratch },
    capturedAt: new Date().toISOString(),
    state,
    artifacts: [artifact],
    cleanup: (await readReceipt(run)).cleanup,
    scalar: artifact,
    human: `Captured ${label}: ${artifact}`,
  };
  try {
    await writeJsonExclusive(artifact, result);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    throw new ControllerError({
      command: "snapshot",
      expected: `an unused snapshot label for run ${run.manifest.runId}`,
      observed: label,
      likelyCause: "Snapshot labels are immutable evidence identities and cannot be overwritten.",
      nextAction: "Choose a new --label or inspect the retained snapshot.",
      exitCode: 2,
    });
  }
  await updateReceipt(run, (receipt) => {
    receipt.actions.push({ command: "snapshot", label, at: result.capturedAt });
    if (!receipt.artifacts.includes(artifact)) receipt.artifacts.push(artifact);
  });
  return result;
}
