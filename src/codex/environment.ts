import { buildReviewProcessEnvironment } from "../review/process-environment.js";

const CODEX_SAFE_KEYS = new Set([
  "CODEX_HOME",
  "MOCK_ACTIVE_TURN_FILE",
  "MOCK_APP_SERVER_MODE",
  "MOCK_APP_SERVER_MODEL",
  "MOCK_APP_SERVER_MODEL_LIST_VARIANTS",
  "MOCK_APP_SERVER_REASONING_VARIANT",
  "MOCK_APP_SERVER_SYSTEM",
  "MOCK_APP_SERVER_USER",
  "MOCK_CLI_EXTRA_VARIANT",
  "MOCK_CLI_COMMAND_LOG",
  "MOCK_CLI_MARKER_FILE",
  "MOCK_CLI_MISSING",
  "MOCK_CLI_MISSING_FRAGMENT",
  "MOCK_CLI_MODE",
  "MOCK_CLI_PID_FILE",
  "MOCK_CLI_STDERR_VALUE",
  "MOCK_INTERRUPT_DELAY_MS",
]);

/** Build the deliberately narrow environment allowed across the Codex process boundary. */
export function buildCodexEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildReviewProcessEnvironment(overrides, inherited, CODEX_SAFE_KEYS);
}
