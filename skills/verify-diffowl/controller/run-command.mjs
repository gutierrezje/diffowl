import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { ControllerError } from "./errors.mjs";
import { binaryPath, helpersRoot, projectRoot } from "./paths.mjs";
import {
  loadRun,
  loadSurfaceRun,
  makeRunId,
  parseLegacyReceipt,
  readReceipt,
  saveRunIndex,
  validateRunId,
  verificationRoot,
  writeJsonAtomic,
  writeManifest,
  writeReceipt,
} from "./run-store.mjs";
import { snapshot } from "./snapshot-command.mjs";
import { inspectProcess, pathExists, runCommand } from "./system.mjs";

export async function executeRun({ adapter, featureId, options }) {
  if (!adapter.features.includes(featureId)) {
    throw new ControllerError({
      command: "run",
      expected: `one of ${adapter.features.join(", ")}`,
      observed: featureId ?? "missing feature ID",
      likelyCause: "The selected feature is not mapped to this surface.",
      nextAction: `Run control-diffowl ${adapter.surface} capabilities --json.`,
      exitCode: 2,
    });
  }
  if (options.dry_run) {
    return {
      schemaVersion: 1,
      command: "run",
      success: true,
      surface: adapter.surface,
      runId: options.run ?? options.run_id ?? null,
      result: "INCONCLUSIVE",
      dryRun: true,
      observedTarget: null,
      artifacts: [],
      cleanup: { removed: [], restored: [], retained: [], running: [] },
      planned: {
        featureId,
        createsRun: !options.run,
        providerUsage: adapter.surface !== "cli",
        persistentScratchMutation: featureId.includes("hook") || featureId.includes("disposition"),
      },
      human: `Would run ${featureId} on ${adapter.surface}${options.run ? ` using ${options.run}` : " in a new scratch"}.`,
    };
  }

  let run;
  if (options.run) {
    run = await loadSurfaceRun(adapter, options.run, "run");
    if (run.manifest.featureId !== featureId) {
      throw new ControllerError({
        command: "run",
        expected: `feature ${run.manifest.featureId} recorded by run ${run.manifest.runId}`,
        observed: featureId,
        likelyCause: "A run is bound to one immutable feature identity.",
        nextAction: "Create a new run for the other feature.",
        exitCode: 2,
      });
    }
  } else {
    const created = await createRun(adapter, featureId, options);
    run = await loadRun(created.runId, "run");
  }

  const requestedModel = options.model ?? run.manifest.requestedModel;
  if (
    adapter.surface !== "cli" &&
    run.manifest.requestedModel !== null &&
    options.model !== undefined &&
    run.manifest.requestedModel !== options.model
  ) {
    throw new ControllerError({
      command: "run",
      expected: `model ${run.manifest.requestedModel} bound to run ${run.manifest.runId}`,
      observed: options.model,
      likelyCause: "A run's requested provider identity is immutable.",
      nextAction: "Create a new run for the other model.",
      exitCode: 2,
    });
  }
  run.manifest.requestedModel = requestedModel ?? null;
  run.manifest.requestedReasoning = options.reasoning ?? run.manifest.requestedReasoning;
  await writeManifest(run, run.manifest);
  const featureOptions = { ...options, model: requestedModel ?? undefined };

  const preparation = adapter.prepareFeature
    ? await adapter.prepareFeature({
        featureId,
        projectRoot,
        binaryPath,
        run,
        options: featureOptions,
      })
    : { mutationRecords: [] };
  run = await loadRun(run.manifest.runId, "run");
  const before = await snapshot(adapter, run.manifest.runId, "before");
  let feature;
  try {
    feature = await adapter.executeFeature({
      featureId,
      projectRoot,
      binaryPath,
      run,
      options: featureOptions,
      capture: (action) =>
        action.owned ? captureOwnedAction(run, action) : captureAction(run, action),
      recordOwnedProcess: (record) => recordOwnedProcess(run, record),
    });
  } catch (error) {
    feature = inconclusiveFeature(error);
  }
  run = await loadRun(run.manifest.runId, "run");
  const after = await snapshot(adapter, run.manifest.runId, "after");
  const repositoryImmutable = JSON.stringify(before.state.git) === JSON.stringify(after.state.git);
  const processes = await Promise.all(
    (run.manifest.ownedProcesses ?? []).map((owned) => inspectProcess(owned.pid)),
  );
  const teardown = processes.every(({ alive }) => !alive);
  const requirementsAgree =
    feature.behavior &&
    repositoryImmutable &&
    teardown &&
    (feature.report === true || feature.report === "not-required") &&
    (feature.database === true || feature.database === "not-required");
  const result =
    feature.result === "INCONCLUSIVE"
      ? "INCONCLUSIVE"
      : requirementsAgree
        ? "VERIFIED"
        : "NOT VERIFIED";

  const preservedArtifacts = await preserveRunArtifacts(run, feature.artifacts);
  const current = await readReceipt(run);
  current.result = result;
  current.observed.push(...feature.observed, {
    check: "repository immutable",
    ok: repositoryImmutable,
    before: before.state.git,
    after: after.state.git,
  });
  current.observed.push({ check: "owned process teardown", ok: teardown, processes });
  current.artifacts.push(
    ...preservedArtifacts.filter((artifact) => !current.artifacts.includes(artifact)),
  );
  current.mutation.records.push(...preparation.mutationRecords, ...feature.mutationRecords);
  current.cleanup.running = processes.filter(({ alive }) => alive).map(({ pid }) => ({ pid }));
  current.confounds.push(...feature.confounds);
  current.controller.state = "completed";
  current.controller.finishedAt = new Date().toISOString();
  run.manifest.effectiveBackend = feature.effectiveBackend ?? null;
  run.manifest.effectiveModel = feature.effectiveModel;
  run.manifest.sessionId = feature.sessionId ?? null;
  run.manifest.turnId = feature.turnId ?? null;
  await writeManifest(run, run.manifest);
  const runtimeIdentity = await adapter.observeRuntime({
    manifest: run.manifest,
    server: { pid: null, port: run.manifest.reservedPort, alive: false, command: null },
  });
  current.target.runtime = JSON.stringify({
    surface: adapter.surface,
    ...runtimeIdentity,
    children: processes,
  });
  await writeReceipt(run, current);

  const receiptPath = join(run.evidence, "receipt.json");
  const runResult = {
    schemaVersion: 1,
    command: "run",
    success: result === "VERIFIED",
    surface: adapter.surface,
    runId: run.manifest.runId,
    result,
    observedTarget: { scratch: run.manifest.scratch },
    evidence: run.evidence,
    receipt: receiptPath,
    verification: {
      behavior: feature.behavior,
      report: feature.report,
      database: feature.database,
      repositoryImmutable,
      teardown,
    },
    artifacts: current.artifacts,
    cleanup: current.cleanup,
    scalar: receiptPath,
    human: `${result}: ${featureId}\nReceipt: ${receiptPath}`,
  };
  if (result !== "VERIFIED") {
    runResult.error = {
      expected: "behavior, report, database, repository immutability, and teardown checks to agree",
      observed: JSON.stringify(runResult.verification),
      likelyCause:
        result === "INCONCLUSIVE"
          ? "A prerequisite or observable identity required by the feature was unavailable."
          : "At least one product result or durable-state check contradicted the feature recipe.",
      nextAction: `Inspect ${receiptPath}, console, and snapshots before cleanup.`,
    };
  }
  return runResult;
}

function inconclusiveFeature(error) {
  const details =
    error instanceof ControllerError
      ? error.details
      : {
          expected: "the provider-backed feature to return observable evidence",
          observed: error instanceof Error ? error.message : String(error),
          likelyCause: "The feature driver or provider failed before its result could be proven.",
          nextAction: "Inspect the captured actions and owned-process state before cleanup.",
        };
  return {
    result: "INCONCLUSIVE",
    behavior: false,
    report: false,
    database: false,
    effectiveBackend: null,
    effectiveModel: null,
    sessionId: null,
    turnId: null,
    observed: [{ check: "feature execution completed", ok: false, error: details }],
    artifacts: [],
    mutationRecords: [],
    confounds: [details],
  };
}

export async function createRun(adapter, featureId, options) {
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
  const runId = options.run_id ? validateRunId(options.run_id, "new-run") : makeRunId();
  const indexPath = join(verificationRoot, "runs", `${runId}.json`);
  if (await pathExists(indexPath)) {
    throw new ControllerError({
      command: "new-run",
      expected: "a unique run ID",
      observed: runId,
      likelyCause: "A verification run already owns this identifier.",
      nextAction: "Choose a new --run-id or reuse the existing run with --run.",
    });
  }

  const helper = join(helpersRoot, "scratch-repo.sh");
  const created = await runCommand(helper, [adapter.surface, featureId, runId], {
    cwd: projectRoot,
    timeout: 30_000,
  });
  if (created.exitCode !== 0) {
    throw new ControllerError({
      command: "new-run",
      expected: "a successful build and disposable Git repository",
      observed: created.stderr || `helper exited ${created.exitCode}`,
      likelyCause: "The existing scratch-repo helper could not establish an exact target.",
      nextAction: "Inspect the build-failed evidence named by stderr, repair the build, and retry.",
    });
  }
  const scratch = created.stdout.split("\n").at(-1);
  const evidenceText = await readFile(join(scratch, ".diffowl-verify", "evidence.path"), "utf8");
  const evidence = evidenceText.trim();
  const legacy = await parseLegacyReceipt(join(evidence, "receipt.txt"));
  const requestedBackend = adapter.surface === "cli" ? null : adapter.surface;
  const requestedModel = options.model ?? null;
  const createdAt = legacy.started_at ?? new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    runId,
    surface: adapter.surface,
    featureId,
    entryPoint: adapter.entryPoints[featureId],
    projectRoot,
    binaryPath,
    scratch,
    evidence,
    createdAt,
    requestedBackend,
    effectiveBackend: null,
    requestedModel,
    effectiveModel: null,
    requestedReasoning: options.reasoning ?? null,
    sessionId: null,
    turnId: null,
    reservedPort: Number(legacy.reserved_port),
    ownedProcesses: [],
  };
  const receipt = {
    schemaVersion: 1,
    command: "receipt",
    success: true,
    result: "INCONCLUSIVE",
    feature: { id: featureId, entryPoint: adapter.entryPoints[featureId] },
    target: {
      source: `${legacy.source_head} (${legacy.source_status_entries} working-tree entries)`,
      artifact: `${legacy.binary} ${legacy.binary_hash} version ${legacy.binary_version}`,
      runtime: `${adapter.surface}; requested model ${requestedModel ?? "none"}; effective runtime pending`,
    },
    actions: [],
    observed: [],
    artifacts: [evidence],
    mutation: { authority: "disposable-repository-only", records: [] },
    cleanup: { removed: [], restored: [], retained: [evidence, scratch], running: [] },
    confounds: [],
    controller: {
      runId,
      surface: adapter.surface,
      state: "created",
      startedAt: createdAt,
      finishedAt: null,
    },
  };
  await Promise.all([
    writeJsonAtomic(join(evidence, "manifest.json"), manifest),
    writeJsonAtomic(join(evidence, "receipt.json"), receipt),
    saveRunIndex(runId, { schemaVersion: 1, runId, surface: adapter.surface, evidence }),
  ]);

  return {
    schemaVersion: 1,
    command: "new-run",
    success: true,
    surface: adapter.surface,
    runId,
    observedTarget: { scratch, evidence },
    artifacts: [evidence, join(evidence, "receipt.json")],
    cleanup: receipt.cleanup,
    scalar: scratch,
    human: `Created ${runId}\nScratch: ${scratch}\nEvidence: ${evidence}`,
  };
}

async function captureAction(run, { label, displayCommand, file, args }) {
  const helper = join(helpersRoot, "capture.sh");
  const captured = await runCommand(
    helper,
    [run.evidence, label, run.manifest.scratch, "--", file, ...args],
    { cwd: projectRoot },
  );
  return readCapturedAction(run, { captured, displayCommand });
}

async function preserveRunArtifacts(run, artifacts) {
  const [scratchRoot, evidenceRoot] = await Promise.all([
    realpath(run.manifest.scratch),
    realpath(run.evidence),
  ]);
  const preserved = [];
  let copyIndex = 0;
  for (const artifact of artifacts) {
    if (!(await pathExists(artifact))) continue;
    const canonical = await realpath(artifact);
    if (isWithin(canonical, evidenceRoot)) {
      preserved.push(canonical);
      continue;
    }
    if (!isWithin(canonical, scratchRoot) || !(await stat(canonical)).isFile()) continue;
    copyIndex += 1;
    const destination = join(
      run.evidence,
      "durable",
      `${String(copyIndex).padStart(2, "0")}-${basename(canonical)}`,
    );
    await mkdir(join(run.evidence, "durable"), { recursive: true });
    await copyFile(canonical, destination);
    preserved.push(destination);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${canonical}${suffix}`;
      if (!(await pathExists(sidecar))) continue;
      const sidecarDestination = `${destination}${suffix}`;
      await copyFile(sidecar, sidecarDestination);
      preserved.push(sidecarDestination);
    }
  }
  return [...new Set(preserved)];
}

function isWithin(path, root) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith("..") && !remainder.startsWith("/"));
}

async function recordOwnedProcess(run, record) {
  const currentRun = await loadRun(run.manifest.runId, "run");
  const existing = currentRun.manifest.ownedProcesses.find(
    (processRecord) => processRecord.pid === record.pid,
  );
  if (existing) Object.assign(existing, record);
  else currentRun.manifest.ownedProcesses.push(record);
  await writeManifest(currentRun, currentRun.manifest);
}

async function captureOwnedAction(run, { label, displayCommand, file, args }) {
  const helper = join(helpersRoot, "capture.sh");
  const child = spawn(helper, [run.evidence, label, run.manifest.scratch, "--", file, ...args], {
    cwd: projectRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) {
    throw new ControllerError({
      command: "run",
      expected: `an owned process for ${displayCommand}`,
      observed: "the operating system returned no PID",
      likelyCause: "The capture helper failed before launch.",
      nextAction: "Retain the run and inspect runtime prerequisites.",
    });
  }
  const pid = child.pid;
  const currentRun = await loadRun(run.manifest.runId, "run");
  currentRun.manifest.ownedProcesses.push({
    pid,
    role: "feature-command",
    expectedCommand: "capture.sh",
    displayCommand,
    processGroup: true,
    state: "running",
    startedAt: new Date().toISOString(),
  });
  await writeManifest(currentRun, currentRun.manifest);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 1)));
  });

  const settledRun = await loadRun(run.manifest.runId, "run");
  const owned = settledRun.manifest.ownedProcesses.find(
    (processRecord) => processRecord.pid === pid,
  );
  if (owned) {
    owned.state = "exited";
    owned.exitCode = exitCode;
    owned.finishedAt = new Date().toISOString();
  }
  await writeManifest(settledRun, settledRun.manifest);
  return readCapturedAction(run, {
    captured: { exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() },
    displayCommand,
  });
}

async function readCapturedAction(run, { captured, displayCommand }) {
  const actionDirectory = captured.stdout.split("\n").at(-1);
  if (!actionDirectory || !(await pathExists(actionDirectory))) {
    throw new ControllerError({
      command: "run",
      expected: `captured evidence for ${displayCommand}`,
      observed: captured.stderr || "capture helper returned no action directory",
      likelyCause: "The existing capture helper rejected the evidence path or command.",
      nextAction: "Inspect the run manifest and retain the scratch for diagnosis.",
    });
  }
  const [stdout, stderr, exitText] = await Promise.all([
    readFile(join(actionDirectory, "stdout.txt"), "utf8"),
    readFile(join(actionDirectory, "stderr.txt"), "utf8"),
    readFile(join(actionDirectory, "exit.txt"), "utf8"),
  ]);
  const receipt = await readReceipt(run);
  receipt.actions.push({
    command: displayCommand,
    actionDirectory,
    exitCode: Number(exitText.trim()),
  });
  if (!receipt.artifacts.includes(actionDirectory)) receipt.artifacts.push(actionDirectory);
  await writeReceipt(run, receipt);
  return {
    actionDirectory,
    exitCode: Number(exitText.trim()),
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}
