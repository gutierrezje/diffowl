import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ControllerError } from "../errors.mjs";
import { parseReviewDocument } from "../provider-document.mjs";
import { inspectPersistedProviderState, validateReviewReport } from "../provider-state.mjs";
import { prepareReviewTarget, reviewTargetArguments, reviewTargetKind } from "../review-target.mjs";
import { inspectPort, inspectProcess, pathExists, runCommand } from "../system.mjs";

const liveReviewFeatures = new Set([
  "opencode-review-staged",
  "opencode-review-last-commit",
  "opencode-review-commit",
  "opencode-review-base",
  "opencode-review-cancel",
]);

export const opencodeAdapter = {
  surface: "opencode",
  description: "Owned OpenCode server, provider route, and review lifecycle",
  features: [
    "opencode-review-staged",
    "opencode-review-last-commit",
    "opencode-review-commit",
    "opencode-review-base",
    "opencode-server-owned-lifecycle",
    "opencode-review-cancel",
    "opencode-hook-review",
  ],
  entryPoints: {
    "opencode-review-staged": "diffowl review --staged --backend opencode",
    "opencode-review-last-commit": "diffowl review --backend opencode",
    "opencode-review-commit": "diffowl review --commit <ref> --backend opencode",
    "opencode-review-base": "diffowl review --base <ref> --backend opencode",
    "opencode-server-owned-lifecycle": "diffowl server start|status|stop",
    "opencode-review-cancel": "Ctrl+C during an OpenCode-backed review",
    "opencode-hook-review": "Git post-commit hook with OpenCode preference",
  },
  async observeRuntime({ manifest, server }) {
    const [version, authentication] = await Promise.all([
      runCommand("opencode", ["--version"]),
      runCommand("opencode", ["auth", "list"]),
    ]);
    return {
      requestedBackend: "opencode",
      effectiveBackend: manifest.effectiveBackend ?? null,
      requestedModel: manifest.requestedModel ?? null,
      effectiveModel: manifest.effectiveModel ?? null,
      authentication: authenticationLabel(authentication),
      toolVersion: version.exitCode === 0 ? version.stdout : null,
      server,
      sessionId: manifest.sessionId ?? null,
      turnId: manifest.turnId ?? null,
    };
  },
  async prepareFeature({ featureId, run }) {
    if (!liveReviewFeatures.has(featureId)) return { mutationRecords: [] };
    return prepareReviewTarget({
      featureId,
      scratch: run.manifest.scratch,
      surface: "opencode",
    });
  },
  async executeFeature({ featureId, capture, binaryPath, run, options, recordOwnedProcess }) {
    if (featureId === "opencode-hook-review") return recipeDrivenResult(featureId);
    if (liveReviewFeatures.has(featureId) && !options.model) {
      throw new ControllerError({
        command: "run",
        expected: "--model <provider/model>",
        observed: "no model",
        likelyCause: "Live OpenCode verification requires an explicit provider route.",
        nextAction: "Choose an already authenticated provider/model and retry.",
        exitCode: 2,
      });
    }

    const start = await capture({
      label: "opencode-server-start",
      displayCommand: "diffowl server start",
      file: "node",
      args: [binaryPath, "server", "start"],
    });
    const pidPath = join(run.manifest.scratch, ".diffowl", "server.pid");
    const pidText = (await pathExists(pidPath)) ? (await readFile(pidPath, "utf8")).trim() : "";
    const serverPid = /^\d+$/.test(pidText) ? Number(pidText) : null;
    if (serverPid) {
      await recordOwnedProcess({
        pid: serverPid,
        role: "opencode-server",
        expectedCommand: "opencode",
        displayCommand: "opencode serve",
        processGroup: false,
        state: "running",
        startedAt: new Date().toISOString(),
      });
    }
    const status = await capture({
      label: "opencode-server-status",
      displayCommand: "diffowl server status",
      file: "node",
      args: [binaryPath, "server", "status"],
    });
    const portBefore = await inspectPort(run.manifest.reservedPort);
    const serverBefore = serverPid ? await inspectProcess(serverPid) : null;

    let reviewed = null;
    let stop = null;
    try {
      if (liveReviewFeatures.has(featureId)) {
        const reviewArgs = [
          binaryPath,
          "review",
          ...reviewTargetArguments(featureId),
          "--backend",
          "opencode",
          "--model",
          options.model,
        ];
        if (options.reasoning) reviewArgs.push("--reasoning", options.reasoning);
        reviewArgs.push("--depth", "shallow", "--format", "json");
        reviewed = await capture({
          label: "opencode-review",
          displayCommand: `diffowl ${reviewArgs.slice(1).join(" ")}`,
          file: "node",
          args: reviewArgs,
          owned: true,
        });
      }
    } finally {
      stop = await capture({
        label: "opencode-server-stop",
        displayCommand: "diffowl server stop",
        file: "node",
        args: [binaryPath, "server", "stop"],
      });
    }

    const portAfter = await inspectPort(run.manifest.reservedPort);
    const serverAfter = serverPid ? await inspectProcess(serverPid) : null;
    const serverStopped =
      stop?.exitCode === 0 && !serverAfter?.alive && !portAfter.listening;
    if (serverPid) {
      const processRecord = {
        pid: serverPid,
        state: serverStopped ? "exited" : "running",
        stopExitCode: stop?.exitCode ?? null,
      };
      if (serverStopped) processRecord.finishedAt = new Date().toISOString();
      await recordOwnedProcess(processRecord);
    }
    const serverLifecycle =
      start.exitCode === 0 &&
      status.exitCode === 0 &&
      serverBefore?.alive === true &&
      portBefore.listening &&
      serverStopped;
    if (featureId === "opencode-server-owned-lifecycle") {
      return {
        result: serverLifecycle ? "VERIFIED" : "NOT VERIFIED",
        behavior: serverLifecycle,
        report: "not-required",
        database: "not-required",
        effectiveBackend: "opencode",
        effectiveModel: null,
        sessionId: null,
        turnId: null,
        observed: [
          {
            check: "owned server start, identity, and stop",
            ok: serverLifecycle,
            pid: serverPid,
            port: run.manifest.reservedPort,
            status: status.stdout,
          },
        ],
        artifacts: [start.actionDirectory, status.actionDirectory],
        mutationRecords: [],
        confounds: serverLifecycle ? [] : ["Owned OpenCode server lifecycle did not agree."],
      };
    }

    const databasePath = join(run.manifest.scratch, ".diffowl", "state.db");
    const databasePersisted = await pathExists(databasePath);
    if (featureId === "opencode-review-cancel") {
      const cancellationObserved =
        reviewed?.exitCode === 130 &&
        /cancel|interrupt/i.test(`${reviewed.stdout}\n${reviewed.stderr}`);
      const databaseState = await inspectPersistedProviderState(
        databasePath,
        run.manifest.scratch,
        {
          backend: "opencode",
          requestedModel: options.model,
          effectiveModel: null,
          sessionId: null,
          terminalOutcome: "cancelled",
          targetKind: reviewTargetKind(featureId),
          reportPath: null,
        },
      );
      return {
        result:
          cancellationObserved && databaseState.agrees && serverLifecycle
            ? "VERIFIED"
            : "NOT VERIFIED",
        behavior: cancellationObserved && serverLifecycle,
        report: "not-required",
        database: databaseState.agrees,
        effectiveBackend: "opencode",
        effectiveModel: null,
        sessionId: null,
        turnId: null,
        observed: [
          { check: "cancellation acknowledged", ok: cancellationObserved },
          { check: "owned server teardown", ok: serverLifecycle },
          {
            check: "terminal cancellation persisted",
            ok: databaseState.agrees,
            state: databaseState,
          },
        ],
        artifacts: [reviewed.actionDirectory, ...(databasePersisted ? [databasePath] : [])],
        mutationRecords: [],
        confounds: cancellationObserved
          ? []
          : ["The review did not expose an acknowledged interruption."],
      };
    }

    const document = parseReviewDocument(reviewed?.stdout ?? "");
    const structuredReview =
      reviewed?.exitCode === 0 &&
      document !== null &&
      document.review?.backend === "opencode" &&
      document.review?.requested_model === options.model &&
      document.review?.target?.kind === reviewTargetKind(featureId);
    const report = document
      ? await validateReviewReport(
          run.manifest.scratch,
          document.review.report_path,
          {
            reviewId: document.review.id,
            sessionId: document.review.session_id,
            targetKind: document.review.target.kind,
          },
        )
      : null;
    const reportPath = report?.path ?? null;
    const reportPersisted = reportPath !== null;
    const databaseState = document
      ? await inspectPersistedProviderState(databasePath, run.manifest.scratch, {
          backend: "opencode",
          requestedModel: document.review.requested_model,
          effectiveModel: document.review.effective_model,
          sessionId: document.review.session_id,
          terminalOutcome: "completed",
          targetKind: document.review.target.kind,
          reportPath,
        })
      : { present: databasePersisted, agrees: false, row: null, inspectionError: null };
    const complete = structuredReview && reportPersisted && databaseState.agrees && serverLifecycle;
    return {
      result: complete ? "VERIFIED" : "NOT VERIFIED",
      behavior: structuredReview && serverLifecycle,
      report: reportPersisted,
      database: databaseState.agrees,
      effectiveBackend: "opencode",
      effectiveModel: document?.review?.effective_model ?? null,
      sessionId: document?.review?.session_id ?? null,
      turnId: null,
      observed: [
        {
          check: "structured review document",
          ok: structuredReview,
          backend: document?.review?.backend ?? null,
          target: document?.review?.target?.kind ?? null,
          requestedModel: document?.review?.requested_model ?? null,
          effectiveModel: document?.review?.effective_model ?? null,
          sessionId: document?.review?.session_id ?? null,
        },
        {
          check: "immutable report identity agrees",
          ok: reportPersisted,
          path: reportPath,
          bytes: report?.bytes ?? null,
          hash: report?.hash ?? null,
        },
        {
          check: "database review agrees",
          ok: databaseState.agrees,
          path: databasePath,
          state: databaseState,
        },
        { check: "owned server teardown", ok: serverLifecycle, pid: serverPid },
      ],
      artifacts: [
        start.actionDirectory,
        status.actionDirectory,
        reviewed.actionDirectory,
        ...(reportPersisted ? [reportPath] : []),
        ...(databasePersisted ? [databasePath] : []),
      ],
      mutationRecords: [],
      confounds:
        complete && document?.review?.effective_model === null
          ? [
              "OpenCode did not report an effective model; verdict is scoped to the requested route.",
            ]
          : complete
            ? []
            : [
                reviewed?.stderr ||
                  "OpenCode output, durable state, or server teardown was incomplete.",
              ],
    };
  },
};

function authenticationLabel(result) {
  if (result.exitCode !== 0) return "not authenticated";
  const providers = stripVTControlCharacters(result.stdout)
    .split("\n")
    .map((line) => line.trim().match(/^●\s+(.+?)\s+(oauth|api)$/i))
    .filter(Boolean)
    .map((match) => `${match[1]} (${match[2].toLowerCase()})`);
  return providers.length > 0 ? `credentials: ${providers.join(", ")}` : "no credentials listed";
}

function recipeDrivenResult(featureId) {
  return {
    result: "INCONCLUSIVE",
    behavior: false,
    report: "not-required",
    database: "not-required",
    effectiveBackend: null,
    effectiveModel: null,
    sessionId: null,
    turnId: null,
    observed: [
      {
        check: "feature automation available",
        ok: false,
        observed: `${featureId} requires a controlled commit and hook-log wait`,
      },
    ],
    artifacts: [],
    mutationRecords: [],
    confounds: [`${featureId} remains recipe-driven to preserve background queue timing evidence.`],
  };
}
