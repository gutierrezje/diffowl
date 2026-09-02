import { join } from "node:path";
import { ControllerError } from "../errors.mjs";
import { parseReviewDocument } from "../provider-document.mjs";
import { inspectPersistedProviderState, resolveOwnedArtifact } from "../provider-state.mjs";
import { prepareReviewTarget, reviewTargetArguments, reviewTargetKind } from "../review-target.mjs";
import { pathExists, runCommand } from "../system.mjs";

const liveReviewFeatures = new Set([
  "codex-runtime-ready",
  "codex-review-staged",
  "codex-review-last-commit",
  "codex-review-commit",
  "codex-review-base",
  "codex-review-cancel",
]);

export const codexAdapter = {
  surface: "codex",
  description: "Per-review Codex App Server children using existing ChatGPT authentication",
  features: [
    "codex-runtime-ready",
    "codex-review-staged",
    "codex-review-last-commit",
    "codex-review-commit",
    "codex-review-base",
    "codex-capability-routing",
    "codex-policy-contract",
    "codex-validation-failure",
    "codex-review-cancel",
  ],
  entryPoints: {
    "codex-runtime-ready": "diffowl backend; diffowl review --backend codex",
    "codex-review-staged": "diffowl review --staged --backend codex",
    "codex-review-last-commit": "diffowl review --backend codex",
    "codex-review-commit": "diffowl review --commit <ref> --backend codex",
    "codex-review-base": "diffowl review --base <ref> --backend codex",
    "codex-capability-routing": "diffowl review --backend codex --reasoning <variant>",
    "codex-policy-contract": "Codex App Server thread/start and turn/start",
    "codex-validation-failure": "Codex structured-review retry path",
    "codex-review-cancel": "Ctrl+C during a Codex-backed review",
  },
  async observeRuntime({ manifest, server }) {
    const [version, login] = await Promise.all([
      runCommand("codex", ["--version"]),
      runCommand("codex", ["login", "status"]),
    ]);
    const authentication =
      login.exitCode === 0 && /chatgpt/i.test(`${login.stdout}\n${login.stderr}`)
        ? "ChatGPT"
        : login.exitCode === 0
          ? "authenticated (mode not established)"
          : "not authenticated";
    return {
      requestedBackend: "codex",
      effectiveBackend: manifest.effectiveBackend ?? null,
      requestedModel: manifest.requestedModel ?? null,
      effectiveModel: manifest.effectiveModel ?? null,
      authentication,
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
      surface: "codex",
    });
  },
  async executeFeature({ featureId, capture, binaryPath, run, options }) {
    if (!liveReviewFeatures.has(featureId)) return recipeDrivenResult(featureId);
    if (!options.model) {
      throw new ControllerError({
        command: "run",
        expected: "--model <bare-codex-model-id>",
        observed: "no model",
        likelyCause: "Live Codex verification requires an explicit requested model identity.",
        nextAction: "Choose a model reported by the effective Codex runtime and retry.",
        exitCode: 2,
      });
    }
    const reviewArgs = [
      binaryPath,
      "review",
      ...reviewTargetArguments(featureId),
      "--backend",
      "codex",
      "--model",
      options.model,
    ];
    if (options.reasoning) reviewArgs.push("--reasoning", options.reasoning);
    reviewArgs.push("--depth", "shallow", "--format", "json");
    const displayCommand = `diffowl ${reviewArgs.slice(1).join(" ")}`;
    const captured = await capture({
      label: "codex-review",
      displayCommand,
      file: "node",
      args: reviewArgs,
      owned: true,
    });

    const databasePath = join(run.manifest.scratch, ".diffowl", "state.db");
    const databasePersisted = await pathExists(databasePath);
    if (featureId === "codex-review-cancel") {
      const cancellationObserved =
        captured.exitCode === 130 &&
        /cancel|interrupt/i.test(`${captured.stdout}\n${captured.stderr}`);
      const databaseState = await inspectPersistedProviderState(
        databasePath,
        run.manifest.scratch,
        {
          backend: "codex",
          requestedModel: options.model,
          effectiveModel: null,
          sessionId: null,
          terminalOutcome: "cancelled",
          targetKind: reviewTargetKind(featureId),
          reportPath: null,
        },
      );
      return {
        result: cancellationObserved && databaseState.agrees ? "VERIFIED" : "NOT VERIFIED",
        behavior: cancellationObserved,
        report: "not-required",
        database: databaseState.agrees,
        effectiveBackend: "codex",
        effectiveModel: null,
        sessionId: null,
        turnId: null,
        observed: [
          {
            check: "cancellation acknowledged",
            ok: cancellationObserved,
            exitCode: captured.exitCode,
          },
          {
            check: "terminal cancellation persisted",
            ok: databaseState.agrees,
            state: databaseState,
          },
        ],
        artifacts: [captured.actionDirectory, ...(databasePersisted ? [databasePath] : [])],
        mutationRecords: [],
        confounds: cancellationObserved
          ? []
          : ["The review did not expose an acknowledged interruption."],
      };
    }

    const document = parseReviewDocument(captured.stdout);
    const expectedTarget = reviewTargetKind(featureId);
    const structuredReview =
      captured.exitCode === 0 &&
      document !== null &&
      document.review?.backend === "codex" &&
      document.review?.requested_model === options.model &&
      document.review?.target?.kind === expectedTarget &&
      document.review?.effective_model !== null;
    const reportPath = await resolveOwnedArtifact(
      run.manifest.scratch,
      document?.review?.report_path,
    );
    const reportPersisted = reportPath !== null;
    const databaseState = document
      ? await inspectPersistedProviderState(databasePath, run.manifest.scratch, {
          backend: "codex",
          requestedModel: document.review.requested_model,
          effectiveModel: document.review.effective_model,
          sessionId: document.review.session_id,
          terminalOutcome: "completed",
          targetKind: document.review.target.kind,
          reportPath,
        })
      : { present: databasePersisted, agrees: false, row: null, inspectionError: null };
    const complete = structuredReview && reportPersisted && databaseState.agrees;
    return {
      result: complete ? "VERIFIED" : "NOT VERIFIED",
      behavior: structuredReview,
      report: reportPersisted,
      database: databaseState.agrees,
      effectiveBackend: "codex",
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
        { check: "immutable report persisted", ok: reportPersisted, path: reportPath },
        {
          check: "database review agrees",
          ok: databaseState.agrees,
          path: databasePath,
          state: databaseState,
        },
      ],
      artifacts: [
        captured.actionDirectory,
        ...(reportPersisted ? [reportPath] : []),
        ...(databasePersisted ? [databasePath] : []),
      ],
      mutationRecords: [],
      confounds: complete
        ? []
        : [captured.stderr || "Codex output or durable state was incomplete."],
    };
  },
};

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
        observed: `${featureId} requires its mock-child recipe and focused contract tests`,
      },
    ],
    artifacts: [],
    mutationRecords: [],
    confounds: [`${featureId} remains recipe-driven to preserve its injected failure semantics.`],
  };
}
