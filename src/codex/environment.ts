const EXACT_SAFE_INHERITED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMP",
  "TMPDIR",
  "TEMP",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "CODEX_HOME",
  "NODE_EXTRA_CA_CERTS",
]);
const WINDOWS_SAFE_INHERITED = new Set(["PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);
const PREFIX_SAFE_INHERITED = ["LC_", "XDG_", "SSL_CERT"];
const CREDENTIAL_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL/i;
const TEST_CONTROLS = new Set([
  "MOCK_APP_SERVER_MODE",
  "MOCK_APP_SERVER_MODEL",
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
]);

/** Build the deliberately narrow environment allowed across the Codex process boundary. */
export function buildCodexEnvironment(
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
  const isWindows = process.platform === "win32";
  const normalizedKey = isWindows ? key.toUpperCase() : key;
  return (
    (isWindows && WINDOWS_SAFE_INHERITED.has(normalizedKey)) ||
    EXACT_SAFE_INHERITED.has(normalizedKey) ||
    PREFIX_SAFE_INHERITED.some((prefix) => normalizedKey.startsWith(prefix)) ||
    TEST_CONTROLS.has(normalizedKey)
  );
}
