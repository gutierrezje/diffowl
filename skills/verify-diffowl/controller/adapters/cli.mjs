import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { pathExists } from "../system.mjs";

export const cliAdapter = {
  surface: "cli",
  description: "Offline CLI, hooks, preferences, and durable findings",
  features: [
    "cli-version-help",
    "cli-invalid-command",
    "preference-select",
    "preference-model-options",
    "preference-preserve-policy",
    "preference-reset",
    "hook-install-status",
    "hook-uninstall",
    "findings-inspect",
    "finding-disposition",
    "finding-duplicate-disposition",
    "init-codex-setup",
    "init-agent-path",
    "agent-hook-install-summary",
  ],
  entryPoints: {
    "cli-version-help": "diffowl -V; diffowl --help",
    "cli-invalid-command": "diffowl <unknown-command>",
    "preference-select": "diffowl backend; diffowl model; diffowl reasoning",
    "preference-model-options": "diffowl reasoning <variant>",
    "preference-preserve-policy": "diffowl backend; diffowl model; diffowl reasoning",
    "preference-reset": "diffowl backend --reset; diffowl model --reset; diffowl reasoning --reset",
    "hook-install-status": "diffowl hook install; diffowl hook status",
    "hook-uninstall": "diffowl hook uninstall",
    "findings-inspect": "diffowl findings list; diffowl findings show",
    "finding-disposition": "diffowl findings dismiss|defer|fix|reopen",
    "finding-duplicate-disposition": "diffowl findings duplicates show|list|confirm|reject",
    "init-codex-setup": "diffowl init",
    "init-agent-path": "diffowl init",
    "agent-hook-install-summary": "diffowl agent-hook install --client claude",
  },
  async observeRuntime({ manifest, server }) {
    return {
      requestedBackend: null,
      effectiveBackend: null,
      requestedModel: null,
      effectiveModel: null,
      authentication: "not-required",
      toolVersion: null,
      server,
      sessionId: manifest.sessionId ?? null,
      turnId: manifest.turnId ?? null,
    };
  },
  async executeFeature({ featureId, capture, projectRoot, binaryPath, run }) {
    switch (featureId) {
      case "cli-version-help": {
        const version = await capture({
          label: "cli-version",
          displayCommand: "diffowl -V",
          file: "node",
          args: [binaryPath, "-V"],
        });
        const help = await capture({
          label: "cli-help",
          displayCommand: "diffowl --help",
          file: "node",
          args: [binaryPath, "--help"],
        });
        const packageDocument = JSON.parse(
          await readFile(join(projectRoot, "package.json"), "utf8"),
        );
        const versionMatches = version.exitCode === 0 && version.stdout === packageDocument.version;
        const helpMatches =
          help.exitCode === 0 &&
          help.stdout.includes("Local AI code review agent") &&
          help.stdout.includes("review [options]") &&
          help.stdout.includes("findings");
        return {
          result: versionMatches && helpMatches ? "VERIFIED" : "NOT VERIFIED",
          behavior: versionMatches && helpMatches,
          report: "not-required",
          database: "not-required",
          effectiveModel: null,
          observed: [
            { check: "version matches package", ok: versionMatches, observed: version.stdout },
            { check: "top-level help exposes expected commands", ok: helpMatches },
          ],
          artifacts: [version.actionDirectory, help.actionDirectory],
          mutationRecords: [],
          confounds: [],
        };
      }
      case "cli-invalid-command": {
        const invalid = await capture({
          label: "cli-invalid-command",
          displayCommand: "diffowl definitely-not-a-command",
          file: "node",
          args: [binaryPath, "definitely-not-a-command"],
        });
        const rejected = invalid.exitCode !== 0 && /unknown command/i.test(invalid.stderr);
        return offlineResult({
          behavior: rejected,
          observed: [
            {
              check: "unknown command rejected",
              ok: rejected,
              exitCode: invalid.exitCode,
              stderr: invalid.stderr,
            },
          ],
          artifacts: [invalid.actionDirectory],
        });
      }
      case "preference-select":
      case "preference-model-options":
      case "preference-preserve-policy": {
        const configPath = join(run.manifest.scratch, ".diffowl.yml");
        const configBefore = await readFile(configPath, "utf8");
        const backend = await capture({
          label: "preference-backend-codex",
          displayCommand: "diffowl backend codex",
          file: "node",
          args: [binaryPath, "backend", "codex"],
        });
        const model = await capture({
          label: "preference-model-codex",
          displayCommand: "diffowl model gpt-5.6-sol",
          file: "node",
          args: [binaryPath, "model", "gpt-5.6-sol"],
        });
        const reasoning = await capture({
          label: "preference-reasoning-codex",
          displayCommand: "diffowl reasoning high",
          file: "node",
          args: [binaryPath, "reasoning", "high"],
        });
        const selectOpenCode =
          featureId === "preference-preserve-policy"
            ? await capture({
                label: "preference-backend-opencode",
                displayCommand: "diffowl backend opencode",
                file: "node",
                args: [binaryPath, "backend", "opencode"],
              })
            : null;
        const preference = await readFile(
          join(run.manifest.scratch, ".diffowl", "preferences.yml"),
          "utf8",
        );
        const configUnchanged = (await readFile(configPath, "utf8")) === configBefore;
        return preferenceResult({
          featureId,
          backend,
          model,
          reasoning,
          selectOpenCode,
          preference,
          configUnchanged,
        });
      }
      case "preference-reset": {
        const configPath = join(run.manifest.scratch, ".diffowl.yml");
        const configBefore = await readFile(configPath, "utf8");
        const preferencePath = join(run.manifest.scratch, ".diffowl", "preferences.yml");
        const selectOpenCodeModel = await capture({
          label: "preference-reset-opencode-model",
          displayCommand: "diffowl model provider/model",
          file: "node",
          args: [binaryPath, "model", "provider/model"],
        });
        const selected = await capture({
          label: "preference-reset-select",
          displayCommand: "diffowl backend codex",
          file: "node",
          args: [binaryPath, "backend", "codex"],
        });
        const selectedModel = await capture({
          label: "preference-reset-model-select",
          displayCommand: "diffowl model gpt-5.6-sol",
          file: "node",
          args: [binaryPath, "model", "gpt-5.6-sol"],
        });
        const selectedReasoning = await capture({
          label: "preference-reset-reasoning-select",
          displayCommand: "diffowl reasoning high",
          file: "node",
          args: [binaryPath, "reasoning", "high"],
        });
        const resetReasoning = await capture({
          label: "preference-reset-reasoning",
          displayCommand: "diffowl reasoning --reset",
          file: "node",
          args: [binaryPath, "reasoning", "--reset"],
        });
        const afterReasoning = parse(await readFile(preferencePath, "utf8"));
        const resetModel = await capture({
          label: "preference-reset-model",
          displayCommand: "diffowl model --reset",
          file: "node",
          args: [binaryPath, "model", "--reset"],
        });
        const afterModel = parse(await readFile(preferencePath, "utf8"));
        const resetBackend = await capture({
          label: "preference-reset-backend",
          displayCommand: "diffowl backend --reset",
          file: "node",
          args: [binaryPath, "backend", "--reset"],
        });
        const afterBackend = parse(await readFile(preferencePath, "utf8"));
        const opencodeSurvives = (document) =>
          document.models?.some(
            (selection) =>
              selection.backend === "opencode" && selection.model === "provider/model",
          );
        const codexAfterReasoning = afterReasoning.models?.find(
          (selection) => selection.backend === "codex",
        );
        const reasoningReset =
          codexAfterReasoning?.model === "gpt-5.6-sol" &&
          codexAfterReasoning.reasoning === undefined &&
          opencodeSurvives(afterReasoning);
        const modelReset =
          !afterModel.models?.some((selection) => selection.backend === "codex") &&
          afterModel.backend === "codex" &&
          opencodeSurvives(afterModel);
        const backendReset = afterBackend.backend === undefined && opencodeSurvives(afterBackend);
        const configUnchanged = (await readFile(configPath, "utf8")) === configBefore;
        const commandsComplete = [
          selectOpenCodeModel,
          selected,
          selectedModel,
          selectedReasoning,
          resetReasoning,
          resetModel,
          resetBackend,
        ].every(({ exitCode }) => exitCode === 0);
        const ok =
          commandsComplete && reasoningReset && modelReset && backendReset && configUnchanged;
        return offlineResult({
          behavior: ok,
          observed: [
            { check: "preference reset commands complete", ok: commandsComplete },
            { check: "reasoning reset state preserves models", ok: reasoningReset },
            { check: "model reset state preserves unrelated backend", ok: modelReset },
            { check: "backend reset state preserves saved models", ok: backendReset },
            { check: "project policy unchanged", ok: configUnchanged },
          ],
          artifacts: [
            selectOpenCodeModel.actionDirectory,
            selected.actionDirectory,
            selectedModel.actionDirectory,
            selectedReasoning.actionDirectory,
            resetReasoning.actionDirectory,
            resetModel.actionDirectory,
            resetBackend.actionDirectory,
          ],
          mutationRecords: [
            { kind: "preferences", path: ".diffowl/preferences.yml", action: "reset" },
          ],
        });
      }
      case "hook-install-status":
      case "hook-uninstall": {
        const hookPath = join(run.manifest.scratch, ".git", "hooks", "post-commit");
        const foreignHook = "#!/bin/sh\nprintf 'foreign hook\\n'\n";
        await mkdir(join(run.manifest.scratch, ".git", "hooks"), { recursive: true });
        await writeFile(hookPath, foreignHook, "utf8");
        await chmod(hookPath, 0o755);
        const install = await capture({
          label: "hook-install",
          displayCommand: "diffowl hook install",
          file: "node",
          args: [binaryPath, "hook", "install"],
        });
        const installedHook = await readFile(hookPath, "utf8");
        const installAgain = await capture({
          label: "hook-install-again",
          displayCommand: "diffowl hook install (idempotence)",
          file: "node",
          args: [binaryPath, "hook", "install"],
        });
        const reinstalledHook = await readFile(hookPath, "utf8");
        const status = await capture({
          label: "hook-status",
          displayCommand: "diffowl hook status",
          file: "node",
          args: [binaryPath, "hook", "status"],
        });
        const uninstall =
          featureId === "hook-uninstall"
            ? await capture({
                label: "hook-uninstall",
                displayCommand: "diffowl hook uninstall",
                file: "node",
                args: [binaryPath, "hook", "uninstall"],
              })
            : null;
        const finalHook = await readFile(hookPath, "utf8");
        const managedCount = installedHook.split("# diffowl-managed").length - 1;
        const installState =
          managedCount === 1 &&
          installedHook === reinstalledHook &&
          installedHook.includes("foreign hook") &&
          installedHook.includes(binaryPath) &&
          /installed|up to date/i.test(status.stdout);
        const uninstallState = uninstall
          ? !finalHook.includes("# diffowl-managed") && finalHook.includes("foreign hook")
          : true;
        const commandsComplete =
          install.exitCode === 0 &&
          installAgain.exitCode === 0 &&
          status.exitCode === 0 &&
          (!uninstall || uninstall.exitCode === 0);
        const ok = commandsComplete && installState && uninstallState;
        return offlineResult({
          behavior: ok,
          observed: [
            {
              check: "hook lifecycle agrees",
              ok,
              commandsComplete,
              installState,
              uninstallState,
            },
          ],
          artifacts: [
            install.actionDirectory,
            installAgain.actionDirectory,
            status.actionDirectory,
            ...(uninstall ? [uninstall.actionDirectory] : []),
            hookPath,
          ],
          mutationRecords: [
            {
              kind: "git-hook",
              path: ".git/hooks/post-commit",
              action: uninstall ? "install-then-uninstall" : "install",
            },
          ],
        });
      }
      case "findings-inspect": {
        const list = await capture({
          label: "findings-list",
          displayCommand: "diffowl findings list --format json",
          file: "node",
          args: [binaryPath, "findings", "list", "--format", "json"],
        });
        const summary = await capture({
          label: "findings-summary",
          displayCommand: "diffowl findings summary --format json",
          file: "node",
          args: [binaryPath, "findings", "summary", "--format", "json"],
        });
        const listDocument = parseJson(list.stdout);
        const summaryDocument = parseJson(summary.stdout);
        const databasePath = join(run.manifest.scratch, ".diffowl", "state.db");
        const database = await pathExists(databasePath);
        const ok =
          list.exitCode === 0 &&
          summary.exitCode === 0 &&
          listDocument !== null &&
          summaryDocument !== null;
        return offlineResult({
          behavior: ok,
          database,
          observed: [
            { check: "findings list JSON", ok: listDocument !== null },
            { check: "findings summary JSON", ok: summaryDocument !== null },
          ],
          artifacts: [
            list.actionDirectory,
            summary.actionDirectory,
            ...(database ? [databasePath] : []),
          ],
        });
      }
      default:
        return {
          result: "INCONCLUSIVE",
          behavior: false,
          report: "not-required",
          database: "not-required",
          effectiveModel: null,
          observed: [
            {
              check: "feature automation available",
              ok: false,
              observed: `${featureId} remains recipe-driven`,
            },
          ],
          artifacts: [],
          mutationRecords: [],
          confounds: [`No automated ${featureId} driver is implemented yet.`],
        };
    }
  },
};

function offlineResult({
  behavior,
  observed,
  artifacts,
  database = "not-required",
  mutationRecords = [],
}) {
  return {
    result:
      behavior && (database === true || database === "not-required") ? "VERIFIED" : "NOT VERIFIED",
    behavior,
    report: "not-required",
    database,
    effectiveModel: null,
    sessionId: null,
    turnId: null,
    observed,
    artifacts,
    mutationRecords,
    confounds: [],
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function preferenceResult({
  featureId,
  backend,
  model,
  reasoning,
  selectOpenCode,
  preference,
  configUnchanged,
}) {
  const document = parse(preference);
  const expectedBackend = selectOpenCode ? "opencode" : "codex";
  const codexSelection = document.models?.find((selection) => selection.backend === "codex");
  const stateAgrees =
    document.backend === expectedBackend &&
    codexSelection?.model === "gpt-5.6-sol" &&
    codexSelection.reasoning?.variant === "high";
  const ok =
    backend.exitCode === 0 &&
    model.exitCode === 0 &&
    reasoning.exitCode === 0 &&
    (!selectOpenCode || selectOpenCode.exitCode === 0) &&
    configUnchanged &&
    stateAgrees;
  return offlineResult({
    behavior: ok,
    observed: [
      { check: `${featureId} commands complete`, ok },
      { check: "project policy unchanged", ok: configUnchanged },
      { check: "preference state agrees", ok: stateAgrees, expectedBackend, document },
    ],
    artifacts: [
      backend.actionDirectory,
      model.actionDirectory,
      reasoning.actionDirectory,
      ...(selectOpenCode ? [selectOpenCode.actionDirectory] : []),
    ],
    mutationRecords: [{ kind: "preferences", path: ".diffowl/preferences.yml", action: featureId }],
  });
}
