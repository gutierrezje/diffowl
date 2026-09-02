import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ControllerError } from "./errors.mjs";
import { binaryPath, helpersRoot, projectRoot } from "./paths.mjs";
import { createRun } from "./run-command.mjs";
import {
  loadSurfaceRun,
  parseLegacyReceipt,
  readReceipt,
  updateReceipt,
} from "./run-store.mjs";
import { snapshot } from "./snapshot-command.mjs";
import { captureState } from "./state.mjs";
import { captureSourceIdentity } from "./source-identity.mjs";
import {
  digest,
  inspectPort,
  inspectProcess,
  pathExists,
  readTextIfPresent,
  runCommand,
} from "./system.mjs";

export async function executeSurfaceCommand({ adapter, command, options, positionals }) {
  switch (command) {
    case "new-run":
      if (options.dry_run) return previewNewRun(adapter, positionals[0], options);
      return createRun(adapter, positionals[0], options);
    case "info":
      return getRunInfo(adapter, options.run);
    case "doctor":
      return doctor(adapter, options.run, options.model);
    case "receipt":
      return getRunReceipt(adapter, options.run);
    case "snapshot":
      return snapshot(adapter, options.run, options.label);
    case "cleanup":
      return cleanup(adapter, options.run, Boolean(options.dry_run));
    case "console":
      return consoleOutput(adapter, options.run, Boolean(options.follow));
    case "network-summary":
      return networkSummary(adapter, options.run);
    case "wait-settle":
      return waitSettle(adapter, options.run, options.timeout_ms, options.interval_ms);
    case "cancel":
      return cancel(adapter, options.run, Boolean(options.dry_run));
    default:
      throw new ControllerError({
        command,
        expected: "a command reported by capabilities",
        observed: command,
        likelyCause: "The requested command is outside the controller interface.",
        nextAction: `Run control-diffowl ${adapter.surface} capabilities --json.`,
        exitCode: 2,
      });
  }
}

function previewNewRun(adapter, featureId, options) {
  if (!adapter.features.includes(featureId)) {
    throw new ControllerError({
      command: "new-run",
      expected: `one of ${adapter.features.join(", ")}`,
      observed: featureId ?? "missing feature ID",
      likelyCause: "The feature is not mapped for this surface.",
      nextAction: `Run control-diffowl ${adapter.surface} capabilities --json.`,
      exitCode: 2,
    });
  }
  return {
    schemaVersion: 1,
    command: "new-run",
    success: true,
    surface: adapter.surface,
    runId: options.run_id ?? null,
    dryRun: true,
    observedTarget: null,
    planned: {
      featureId,
      requestedModel: options.model ?? null,
      requestedReasoning: options.reasoning ?? null,
      actions: ["build checkout", "create disposable Git repository", "retain evidence"],
    },
    artifacts: [],
    cleanup: { removed: [], restored: [], retained: [], running: [] },
    human: `Would build the checkout and create a ${adapter.surface} run for ${featureId}.`,
  };
}

async function getRunInfo(adapter, runIdInput) {
  const run = await loadSurfaceRun(adapter, runIdInput, "info");
  const receipt = await readReceipt(run);
  const scratchPresent = await pathExists(run.manifest.scratch);
  const result = {
    schemaVersion: 1,
    command: "info",
    success: true,
    surface: adapter.surface,
    runId: run.manifest.runId,
    feature: run.manifest.featureId,
    state: receipt.controller.state,
    result: receipt.result,
    observedTarget: {
      scratch: run.manifest.scratch,
      scratchPresent,
      evidence: run.evidence,
    },
    artifacts: receipt.artifacts,
    cleanup: receipt.cleanup,
    human: `${run.manifest.runId}: ${receipt.result} (${receipt.controller.state})\nScratch: ${scratchPresent ? run.manifest.scratch : "removed"}\nEvidence: ${run.evidence}`,
  };
  return result;
}

async function doctor(adapter, runIdInput, requestedModel) {
  const run = runIdInput ? await loadSurfaceRun(adapter, runIdInput, "doctor") : null;
  const legacy = run ? await parseLegacyReceipt(join(run.evidence, "receipt.txt")) : null;
  const readiness = await runCommand(join(helpersRoot, "doctor.sh"), [projectRoot], {
    cwd: projectRoot,
  });
  const localIdentity = parseDoctorOutput(readiness.stdout);
  const scratch = run?.manifest.scratch ?? null;
  const port = run?.manifest.reservedPort ?? null;
  const pidText = scratch ? await readTextIfPresent(join(scratch, ".diffowl", "server.pid")) : null;
  const recordedPid = pidText && /^\d+$/.test(pidText.trim()) ? Number(pidText.trim()) : null;
  const processIdentity = recordedPid ? await inspectProcess(recordedPid) : null;
  const server = {
    pid: processIdentity?.alive ? recordedPid : null,
    port,
    alive: processIdentity?.alive ?? false,
    command: processIdentity?.command ?? null,
  };
  const runtimeManifest = run?.manifest ?? {
    requestedModel: requestedModel ?? null,
    effectiveBackend: null,
    effectiveModel: null,
    sessionId: null,
    turnId: null,
  };
  const runtime = await adapter.observeRuntime({ manifest: runtimeManifest, server });
  const children = await Promise.all(
    (run?.manifest.ownedProcesses ?? []).map(async (owned) => ({
      ...owned,
      ...(await inspectProcess(owned.pid)),
    })),
  );
  runtime.children = children;

  const problems = [];
  if (readiness.exitCode !== 0) problems.push("shared readiness helper failed");
  if (localIdentity.source.head === null) problems.push("source HEAD unavailable");
  if (localIdentity.binary.version === null) problems.push("binary version unavailable");
  if (localIdentity.binary.hash === null) problems.push("binary hash unavailable");
  if (legacy && legacy.source_head !== localIdentity.source.head)
    problems.push("run source HEAD no longer matches checkout");
  const sourceIdentity = await captureSourceIdentity(projectRoot);
  if (run?.manifest.sourceIdentity?.hash !== undefined && run.manifest.sourceIdentity.hash !== sourceIdentity.hash)
    problems.push("run source content identity no longer matches checkout");
  const controllerHash = digest(await readFile(run?.manifest.controllerPath ?? join(projectRoot, "skills", "verify-diffowl", "control-diffowl")));
  if (run?.manifest.controllerHash !== undefined && run.manifest.controllerHash !== controllerHash)
    problems.push("run controller artifact no longer matches checkout");
  if (legacy && legacy.binary_hash !== localIdentity.binary.hash)
    problems.push("run artifact no longer matches current binary");
  if (adapter.surface === "codex" && runtime.authentication !== "ChatGPT") {
    problems.push("Codex ChatGPT authentication not effective");
  }
  if (server.pid !== null && adapter.surface !== "opencode") {
    problems.push("unexpected long-lived server for this surface");
  }

  const result = {
    schemaVersion: 1,
    command: "doctor",
    success: problems.length === 0,
    surface: adapter.surface,
    runId: run?.manifest.runId ?? null,
    observedTarget: { scratch, evidence: run?.evidence ?? null },
    identity: {
      source: {
        head: localIdentity.source.head,
        dirty: localIdentity.source.dirtyEntries > 0,
        dirtyEntries: localIdentity.source.dirtyEntries,
        hash: sourceIdentity.hash,
      },
      binary: { path: binaryPath, ...localIdentity.binary, controllerHash },
      scratch: { path: scratch, present: scratch ? await pathExists(scratch) : false },
      runtime,
    },
    readiness: {
      helper: join(helpersRoot, "doctor.sh"),
      exitCode: readiness.exitCode,
      stderr: readiness.stderr || null,
    },
    problems,
    artifacts: run ? [run.evidence] : [],
    cleanup: run
      ? (await readReceipt(run)).cleanup
      : { removed: [], restored: [], retained: [], running: [] },
    human:
      problems.length === 0
        ? "Doctor found a consistent runtime identity."
        : `Doctor found: ${problems.join("; ")}`,
  };
  if (problems.length > 0) {
    result.error = {
      expected: "source, artifact, runtime, authentication, and process identity to agree",
      observed: problems.join("; "),
      likelyCause: "The configured target and effective runtime identity are inconsistent.",
      nextAction:
        "Apply the reported rebuild, authentication, or owned-cleanup action, then rerun doctor.",
    };
  }
  return result;
}

function parseDoctorOutput(output) {
  const binary = output.match(/diffowl CLI (\S+) \((.+), artifact ([a-f0-9]+)\)/i);
  const source = output.match(/source target: (\S+) \((\d+) working-tree entries\)/i);
  return {
    source: {
      head: source?.[1] ?? null,
      dirtyEntries: source ? Number(source[2]) : 0,
    },
    binary: {
      version: binary?.[1] ?? null,
      hash: binary?.[3] ?? null,
    },
  };
}

async function getRunReceipt(adapter, runIdInput) {
  const run = await loadSurfaceRun(adapter, runIdInput, "receipt");
  return { ...(await readReceipt(run)), surface: adapter.surface, runId: run.manifest.runId };
}

async function consoleOutput(adapter, runIdInput, follow) {
  const run = await loadSurfaceRun(adapter, runIdInput, "console");
  const receipt = await readReceipt(run);
  const events = [];
  let sequence = 0;
  for (const action of receipt.actions) {
    if (!action.actionDirectory) continue;
    for (const stream of ["stdout", "stderr"]) {
      const path = join(action.actionDirectory, `${stream}.txt`);
      const text = await readTextIfPresent(path);
      if (text === null) continue;
      for (const line of text.split("\n")) {
        if (!line) continue;
        sequence += 1;
        events.push({
          schemaVersion: 1,
          command: "console",
          success: true,
          surface: adapter.surface,
          runId: run.manifest.runId,
          sequence,
          source: `${action.command} ${stream}`,
          line,
        });
      }
    }
  }
  const hookLog = await readTextIfPresent(join(run.manifest.scratch, ".diffowl", "hook.log"));
  if (hookLog) {
    for (const line of hookLog.split("\n")) {
      if (!line) continue;
      sequence += 1;
      events.push({
        schemaVersion: 1,
        command: "console",
        success: true,
        surface: adapter.surface,
        runId: run.manifest.runId,
        sequence,
        source: "hook log",
        line,
      });
    }
  }
  for (const action of receipt.actions.filter(({ state }) => state === "running")) {
    sequence += 1;
    events.push({
      schemaVersion: 1,
      command: "console",
      success: true,
      surface: adapter.surface,
      runId: run.manifest.runId,
      sequence,
      source: "controller",
      line: `${action.command} is running; evidence: ${action.actionDirectory}`,
    });
  }
  if (events.length === 0) {
    events.push({
      schemaVersion: 1,
      command: "console",
      success: true,
      surface: adapter.surface,
      runId: run.manifest.runId,
      sequence: 1,
      source: "controller",
      line: "No recorded console output.",
    });
  }
  if (follow) {
    events.push({
      schemaVersion: 1,
      command: "console",
      success: true,
      surface: adapter.surface,
      runId: run.manifest.runId,
      sequence: events.length + 1,
      source: "controller",
      line: "Follow completed at the current durable end of stream.",
    });
  }
  return { success: true, jsonLines: events };
}

async function networkSummary(adapter, runIdInput) {
  const run = await loadSurfaceRun(adapter, runIdInput, "network-summary");
  const port = run.manifest.reservedPort;
  const pidText = await readTextIfPresent(join(run.manifest.scratch, ".diffowl", "server.pid"));
  const recordedPid = pidText && /^\d+$/.test(pidText.trim()) ? Number(pidText.trim()) : null;
  const [portState, processState] = await Promise.all([
    inspectPort(port),
    recordedPid ? inspectProcess(recordedPid) : Promise.resolve(null),
  ]);
  return {
    schemaVersion: 1,
    command: "network-summary",
    success: true,
    surface: adapter.surface,
    runId: run.manifest.runId,
    observedTarget: { scratch: run.manifest.scratch },
    network: {
      port,
      listening: portState.listening,
      pid: processState?.alive ? recordedPid : null,
      command: processState?.command ?? null,
    },
    artifacts: [run.evidence],
    cleanup: (await readReceipt(run)).cleanup,
    human: `Port ${port}: ${portState.listening ? "listening" : "closed"}; PID ${processState?.alive ? recordedPid : "none"}`,
  };
}

async function waitSettle(adapter, runIdInput, timeoutInput, intervalInput) {
  const run = await loadSurfaceRun(adapter, runIdInput, "wait-settle");
  const timeout = parseBoundedMilliseconds(timeoutInput, 30_000, 1, 60_000, "--timeout-ms");
  const interval = parseBoundedMilliseconds(intervalInput, 250, 10, 5_000, "--interval-ms");
  const started = Date.now();
  let firstState = await captureState(run);
  let lastLifecycle = null;

  while (Date.now() - started <= timeout) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
    const [secondState, network] = await Promise.all([
      captureState(run),
      networkSummary(adapter, run.manifest.runId),
    ]);
    const receipt = await readReceipt(run);
    const childrenRunning = secondState.processes
      .filter(({ alive, state }) => alive && state === "running")
      .map(({ pid, role }) => ({ pid, role }));
    const durableStateStable =
      JSON.stringify({ database: firstState.database, reviews: firstState.reviews }) ===
      JSON.stringify({ database: secondState.database, reviews: secondState.reviews });
    lastLifecycle = {
      childrenRunning,
      serverListening: network.network.listening,
      durableStateStable,
      controllerState: receipt.controller.state,
    };
    if (
      isTerminalControllerState(receipt.controller.state) &&
      childrenRunning.length === 0 &&
      !network.network.listening &&
      durableStateStable
    ) {
      return {
        schemaVersion: 1,
        command: "wait-settle",
        success: true,
        surface: adapter.surface,
        runId: run.manifest.runId,
        settled: true,
        waitedMs: Date.now() - started,
        observedTarget: { scratch: run.manifest.scratch },
        lifecycle: lastLifecycle,
        artifacts: [run.evidence],
        cleanup: (await readReceipt(run)).cleanup,
        human: `Settled after ${Date.now() - started}ms.`,
      };
    }
    firstState = secondState;
  }

  return {
    schemaVersion: 1,
    command: "wait-settle",
    success: false,
    surface: adapter.surface,
    runId: run.manifest.runId,
    settled: false,
    waitedMs: Date.now() - started,
    observedTarget: { scratch: run.manifest.scratch },
    lifecycle: lastLifecycle,
    artifacts: [run.evidence],
    cleanup: (await readReceipt(run)).cleanup,
    error: {
      expected: "no owned children, no owned server listener, and stable durable state",
      observed: JSON.stringify(lastLifecycle),
      likelyCause:
        "The review, persistence, or child-process lifecycle did not settle before the deadline.",
      nextAction:
        "Inspect console and network-summary, then retry wait-settle or cancel the named run.",
    },
    human: `Did not settle within ${timeout}ms.`,
  };
}

async function cancel(adapter, runIdInput, dryRun) {
  const run = await loadSurfaceRun(adapter, runIdInput, "cancel");
  const ownedProcesses = (
    await Promise.all(
      (run.manifest.ownedProcesses ?? []).filter(({ state }) => state === "running").map(async (owned) => ({
        ...owned,
        ...(await inspectProcess(owned.pid)),
      })),
    )
  ).filter(({ alive }) => alive);
  if (dryRun) {
    return {
      schemaVersion: 1,
      command: "cancel",
      success: true,
      surface: adapter.surface,
      runId: run.manifest.runId,
      dryRun: true,
      observedTarget: { scratch: run.manifest.scratch },
      ownedProcesses,
      artifacts: [run.evidence],
      cleanup: (await readReceipt(run)).cleanup,
      human: `Would send SIGINT to ${ownedProcesses.length} owned process(es).`,
    };
  }
  if (ownedProcesses.length === 0) {
    throw new ControllerError({
      command: "cancel",
      expected: "an active process recorded as owned by this run",
      observed: "no live owned process",
      likelyCause: "The feature already settled or was not started through this controller.",
      nextAction: "Use wait-settle and receipt to inspect the terminal outcome.",
    });
  }
  for (const owned of ownedProcesses) {
    assertOwnedProcess(owned, "cancel");
    signalOwnedProcess(owned, "SIGINT");
  }
  const receipt = await updateReceipt(run, (current) => {
    current.actions.push({
      command: "cancel",
      signal: "SIGINT",
      pids: ownedProcesses.map(({ pid }) => pid),
      at: new Date().toISOString(),
    });
  });
  return {
    schemaVersion: 1,
    command: "cancel",
    success: true,
    surface: adapter.surface,
    runId: run.manifest.runId,
    dryRun: false,
    observedTarget: { scratch: run.manifest.scratch },
    ownedProcesses,
    artifacts: [run.evidence],
    cleanup: receipt.cleanup,
    human: `Sent SIGINT to ${ownedProcesses.map(({ pid }) => pid).join(", ")}.`,
  };
}

function parseBoundedMilliseconds(input, fallback, minimum, maximum, flag) {
  if (input === undefined) return fallback;
  const value = Number(input);
  if (Number.isSafeInteger(value) && value >= minimum && value <= maximum) return value;
  throw new ControllerError({
    command: "wait-settle",
    expected: `${flag} between ${minimum} and ${maximum}`,
    observed: input,
    likelyCause: "The wait bound is not a safe supported integer.",
    nextAction: "Choose a bounded millisecond value from the documented range.",
    exitCode: 2,
  });
}

async function cleanup(adapter, runIdInput, dryRun) {
  const run = await loadSurfaceRun(adapter, runIdInput, "cleanup");
  const receipt = await readReceipt(run);
  const scratchPresent = await pathExists(run.manifest.scratch);
  const recoveredRemoval =
    !scratchPresent &&
    receipt.cleanup.state === "removing" &&
    receipt.cleanup.target === run.manifest.scratch;
  const running = (
    await Promise.all(
      (run.manifest.ownedProcesses ?? []).filter(({ state }) => state === "running").map(async (owned) => ({
        ...owned,
        ...(await inspectProcess(owned.pid)),
      })),
    )
  ).filter(({ alive }) => alive);

  if (dryRun) {
    return {
      schemaVersion: 1,
      command: "cleanup",
      success: true,
      surface: adapter.surface,
      runId: run.manifest.runId,
      dryRun: true,
      observedTarget: { scratch: run.manifest.scratch, scratchPresent },
      artifacts: receipt.artifacts,
      cleanup: {
        removed: [],
        restored: [],
        retained: [run.evidence, ...(scratchPresent ? [run.manifest.scratch] : [])],
        running: running.map(({ pid, role }) => ({ pid, role })),
      },
      human: `Would stop ${running.length} owned process(es) and ${scratchPresent ? "remove" : "retain absent"} ${run.manifest.scratch}. Evidence remains at ${run.evidence}.`,
    };
  }

  for (const owned of running.filter(({ role }) => role !== "opencode-server")) {
    assertOwnedProcess(owned, "cleanup");
    signalOwnedProcess(owned, "SIGINT");
  }
  for (const owned of running.filter(({ role }) => role === "opencode-server")) {
    assertOwnedProcess(owned, "cleanup");
  }
  const childDeadline = Date.now() + 5_000;
  while (Date.now() < childDeadline) {
    const liveChildren = (
      await Promise.all(
        running
          .filter(({ role }) => role !== "opencode-server")
          .map((owned) => inspectProcess(owned.pid)),
      )
    ).filter(({ alive }) => alive);
    if (liveChildren.length === 0) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const retainedChildren = (
    await Promise.all(
      running
        .filter(({ role }) => role !== "opencode-server")
        .map((owned) => inspectProcess(owned.pid)),
    )
  ).filter(({ alive }) => alive);
  if (retainedChildren.length > 0) {
    throw new ControllerError({
      command: "cleanup",
      expected: "owned feature processes to acknowledge SIGINT and exit",
      observed: retainedChildren.map(({ pid, command }) => ({ pid, command })),
      likelyCause: "A run-owned feature process did not complete cancellation.",
      nextAction: "Retain the scratch and inspect console output before retrying cleanup.",
    });
  }

  const safeReceipt = await waitForCleanupSafeState(run, 10_000);
  await updateReceipt(run, (current) => {
    const requestedAt = current.cleanup.requestedAt ?? new Date().toISOString();
    current.cleanup.target = run.manifest.scratch;
    current.cleanup.state = "removing";
    current.cleanup.requestedAt = requestedAt;
  });

  const helper = join(helpersRoot, "cleanup.sh");
  const cleaned = await runCommand(helper, [run.evidence], { cwd: projectRoot, timeout: 15_000 });
  if (cleaned.exitCode !== 0) {
    await updateReceipt(run, (current) => {
      current.cleanup.state = "failed";
      current.cleanup.running = safeReceipt.cleanup.running;
    });
    throw new ControllerError({
      command: "cleanup",
      expected: "owned processes stopped and only the recorded scratch removed",
      observed: cleaned.stderr || `cleanup helper exited ${cleaned.exitCode}`,
      likelyCause: "Ownership checks failed or an owned process did not settle.",
      nextAction:
        "Run snapshot and cleanup --dry-run, then inspect the recorded PID before retrying.",
    });
  }
  const completedReceipt = await updateReceipt(run, (current) => {
    if (current.controller.state === "created") current.controller.state = "cleaned";
    current.controller.finishedAt ??= new Date().toISOString();
    const removed = new Set(current.cleanup.removed);
    if (scratchPresent || recoveredRemoval) removed.add(run.manifest.scratch);
    current.cleanup = {
      ...current.cleanup,
      state: "completed",
      target: run.manifest.scratch,
      removed: [...removed],
      restored: [],
      retained: [run.evidence],
      running: [],
      completedAt: new Date().toISOString(),
      recovered: recoveredRemoval,
    };
  });
  return {
    schemaVersion: 1,
    command: "cleanup",
    success: true,
    surface: adapter.surface,
    runId: run.manifest.runId,
    dryRun: false,
    observedTarget: { scratch: run.manifest.scratch, scratchPresent: false },
    artifacts: completedReceipt.artifacts,
    cleanup: completedReceipt.cleanup,
    human: cleaned.stdout || `Removed ${run.manifest.scratch}`,
  };
}

function isTerminalControllerState(state) {
  return state === "completed" || state === "failed" || state === "cleaned";
}

async function waitForCleanupSafeState(run, timeout) {
  const deadline = Date.now() + timeout;
  while (true) {
    const receipt = await readReceipt(run);
    if (receipt.controller.state === "created" || isTerminalControllerState(receipt.controller.state)) {
      return receipt;
    }
    const owner = receipt.controller.owner;
    if (owner) {
      const observed = await inspectProcess(owner.pid);
      const ownerAlive =
        observed.alive &&
        owner.launchStartedAt === observed.processStartedAt &&
        owner.launchProcessGroupId === observed.processGroupId &&
        observed.command?.includes(owner.expectedCommand);
      if (!ownerAlive) {
        return updateReceipt(run, (current) => {
          if (current.controller.state !== "running") return;
          const error = {
            expected: "the run controller to reach a terminal state before cleanup",
            observed: "the recorded controller owner exited while the run remained active",
            likelyCause: "The controller was interrupted outside its owned cancellation path.",
            nextAction: "Inspect retained actions and snapshots; the abandoned run is inconclusive.",
          };
          current.result = "INCONCLUSIVE";
          current.observed.push({ check: "controller lifecycle completed", ok: false, error });
          current.confounds.push(error);
          current.controller.state = "failed";
          current.controller.finishedAt = new Date().toISOString();
        });
      }
    }
    if (Date.now() >= deadline) {
      throw new ControllerError({
        command: "cleanup",
        expected: "the active run controller to finish after owned-process cancellation",
        observed: `controller remained ${receipt.controller.state}`,
        likelyCause: "The provider or evidence finalization did not acknowledge cancellation.",
        nextAction: "Retain the scratch, inspect console and receipt, then retry cleanup.",
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

function assertOwnedProcess(owned, command) {
  const commandMatches =
    owned.expectedCommand?.length > 0 &&
    owned.command?.includes(owned.expectedCommand);
  const startMatches =
    owned.launchStartedAt?.length > 0 &&
    owned.launchStartedAt === owned.processStartedAt;
  const groupMatches =
    Number.isSafeInteger(owned.launchProcessGroupId) &&
    owned.launchProcessGroupId === owned.processGroupId;
  if (commandMatches && startMatches && groupMatches) return;
  throw new ControllerError({
    command,
    expected: `PID ${owned.pid} launch command, start time, and process group recorded by this run`,
    observed: JSON.stringify({
      command: owned.command ?? null,
      expectedCommand: owned.expectedCommand ?? null,
      processStartedAt: owned.processStartedAt ?? null,
      launchStartedAt: owned.launchStartedAt ?? null,
      processGroupId: owned.processGroupId ?? null,
      launchProcessGroupId: owned.launchProcessGroupId ?? null,
    }),
    likelyCause: "The recorded PID was reused or no longer belongs to the run.",
    nextAction: "Retain the run and inspect process identity; do not signal this PID.",
  });
}

function signalOwnedProcess(owned, signal) {
  process.kill(
    owned.processGroup ? -owned.launchProcessGroupId : owned.pid,
    signal,
  );
}
