const SAFE_INHERITED =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMP|TMPDIR|TEMP|LANG|LC_|TERM$|COLORTERM$|NO_COLOR$|XDG_|CODEX_HOME$|SSL_CERT|NODE_EXTRA_CA_CERTS$)/;
const CREDENTIAL_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL/i;
const TEST_CONTROLS = new Set([
  "MOCK_APP_SERVER_MODE",
  "MOCK_APP_SERVER_MODEL",
  "MOCK_APP_SERVER_SYSTEM",
  "MOCK_APP_SERVER_USER",
  "MOCK_CLI_EXTRA_VARIANT",
  "MOCK_CLI_MARKER_FILE",
  "MOCK_CLI_MISSING",
  "MOCK_CLI_MISSING_FRAGMENT",
  "MOCK_CLI_MODE",
  "MOCK_CLI_PID_FILE",
  "MOCK_CLI_STDERR_VALUE",
]);

/** Build the deliberately narrow environment allowed across the experiment process boundary. */
export function buildExperimentEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && isAllowed(key)) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && isAllowed(key)) environment[key] = value;
  }
  for (const key of Object.keys(environment)) {
    if (CREDENTIAL_KEY.test(key) || key === "SSH_AUTH_SOCK") delete environment[key];
  }
  return environment;
}

function isAllowed(key: string): boolean {
  return SAFE_INHERITED.test(key) || TEST_CONTROLS.has(key);
}
