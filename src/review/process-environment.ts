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
  "NODE_EXTRA_CA_CERTS",
]);
const WINDOWS_SAFE_INHERITED = new Set(["PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);
const PREFIX_SAFE_INHERITED = ["LC_", "XDG_", "SSL_CERT"];
const CREDENTIAL_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL/i;

/** Build the narrow environment allowed across a review-provider process boundary. */
export function buildReviewProcessEnvironment(
  overrides: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv,
  providerSafeKeys: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && isAllowed(key, providerSafeKeys)) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && isAllowed(key, providerSafeKeys)) environment[key] = value;
  }
  for (const key of Object.keys(environment)) {
    if (CREDENTIAL_KEY.test(key) || key === "SSH_AUTH_SOCK") delete environment[key];
  }
  return environment;
}

function isAllowed(key: string, providerSafeKeys: ReadonlySet<string>): boolean {
  const isWindows = process.platform === "win32";
  const normalizedKey = isWindows ? key.toUpperCase() : key;
  return (
    (isWindows && WINDOWS_SAFE_INHERITED.has(normalizedKey)) ||
    EXACT_SAFE_INHERITED.has(normalizedKey) ||
    PREFIX_SAFE_INHERITED.some((prefix) => normalizedKey.startsWith(prefix)) ||
    providerSafeKeys.has(normalizedKey)
  );
}
