import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative } from "node:path";
import { execa } from "execa";
import { buildCodexEnvironment } from "./environment.js";

export type ProtocolEvidenceOptions = {
  executable: string;
  prefixArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type CodexProtocolEvidence = {
  codexCliVersion: string;
  generatedWithoutExperimentalApi: true;
  typesSha256: string;
  jsonSchemaSha256: string;
  typesFileCount: number;
  jsonSchemaFileCount: number;
};

export type ProtocolEvidenceErrorKind =
  | "executable-missing"
  | "generation-failed"
  | "protocol-incompatible"
  | "cancelled"
  | "timeout";

export class ProtocolEvidenceError extends Error {
  readonly kind: ProtocolEvidenceErrorKind;

  constructor(kind: ProtocolEvidenceErrorKind, message: string) {
    super(message);
    this.name = "ProtocolEvidenceError";
    this.kind = kind;
  }
}

export class ProtocolGenerationError extends ProtocolEvidenceError {
  readonly phase: string;
  readonly stderr: string;

  constructor(phase: string, stderr: string) {
    super("generation-failed", `Codex protocol generation failed during ${phase}.`);
    this.name = "ProtocolGenerationError";
    this.phase = phase;
    this.stderr = stderr;
  }
}

export class ProtocolTimeoutError extends ProtocolEvidenceError {
  readonly phase: string;

  constructor(phase: string) {
    super("timeout", `Codex protocol evidence timed out during ${phase}.`);
    this.name = "ProtocolTimeoutError";
    this.phase = phase;
  }
}

export class ProtocolCancelledError extends ProtocolEvidenceError {
  readonly phase: string;

  constructor(phase: string) {
    super("cancelled", `Codex protocol evidence was cancelled during ${phase}.`);
    this.name = "ProtocolCancelledError";
    this.phase = phase;
  }
}

const REQUIRED_TS_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "ClientNotification.ts": ["initialized"],
  "ClientRequest.ts": [
    "initialize",
    "account/read",
    "thread/start",
    "turn/start",
    "turn/interrupt",
  ],
  "ServerNotification.ts": [
    "item/completed",
    "turn/completed",
    "thread/tokenUsage/updated",
    "item/agentMessage/delta",
    "model/rerouted",
  ],
  "v2/AgentMessageDeltaNotification.ts": ["threadId", "turnId", "itemId", "delta"],
  "v2/ItemCompletedNotification.ts": ["threadId", "turnId", "item", "completedAtMs"],
  "v2/GetAccountParams.ts": ["refreshToken"],
  "v2/GetAccountResponse.ts": ["account", "requiresOpenaiAuth"],
  "v2/ThreadStartParams.ts": ["approvalPolicy", "sandbox"],
  "v2/ThreadStartResponse.ts": [
    "thread",
    "model",
    "modelProvider",
    "cwd",
    "approvalPolicy",
    "sandbox",
  ],
  "v2/TurnStartParams.ts": ["threadId", "outputSchema", "approvalPolicy", "sandboxPolicy"],
  "v2/TurnStartResponse.ts": ["turn"],
  "v2/TurnInterruptParams.ts": ["threadId", "turnId"],
  "v2/TurnCompletedNotification.ts": ["threadId"],
  "v2/ThreadTokenUsageUpdatedNotification.ts": ["threadId", "turnId"],
  "v2/ThreadTokenUsage.ts": ["total", "last"],
  "v2/TokenUsageBreakdown.ts": [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ],
  "v2/TurnError.ts": ["message", "codexErrorInfo", "additionalDetails"],
  "v2/CodexErrorInfo.ts": ["contextWindowExceeded", "other", "httpConnectionFailed"],
  "v2/ModelReroutedNotification.ts": ["threadId", "turnId", "fromModel", "toModel", "reason"],
  "v2/ModelRerouteReason.ts": ["highRiskCyberActivity"],
  "v2/AskForApproval.ts": ["never"],
  "v2/SandboxMode.ts": ["read-only"],
  "v2/SandboxPolicy.ts": ["readOnly"],
  "v2/Turn.ts": ["id", "status", "error", "items"],
  "v2/TurnStatus.ts": ["completed", "interrupted", "failed", "inProgress"],
};

const REQUIRED_JSON_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "ClientNotification.json": ["initialized"],
  "ClientRequest.json": [
    "initialize",
    "account/read",
    "thread/start",
    "turn/start",
    "turn/interrupt",
  ],
  "ServerNotification.json": [
    "item/completed",
    "turn/completed",
    "thread/tokenUsage/updated",
    "item/agentMessage/delta",
    "model/rerouted",
  ],
  "v2/AgentMessageDeltaNotification.json": ["threadId", "turnId", "itemId", "delta"],
  "v2/ItemCompletedNotification.json": ["threadId", "turnId", "item", "completedAtMs"],
  "v2/GetAccountParams.json": ["refreshToken"],
  "v2/GetAccountResponse.json": ["account", "requiresOpenaiAuth"],
  "v2/ThreadStartParams.json": ["approvalPolicy", "sandbox", "never", "read-only"],
  "v2/ThreadStartResponse.json": [
    "thread",
    "model",
    "modelProvider",
    "cwd",
    "approvalPolicy",
    "sandbox",
  ],
  "v2/TurnStartParams.json": [
    "threadId",
    "outputSchema",
    "approvalPolicy",
    "sandboxPolicy",
    "never",
    "readOnly",
  ],
  "v2/TurnStartResponse.json": ["turn"],
  "v2/ModelReroutedNotification.json": ["threadId", "turnId", "fromModel", "toModel", "reason"],
  "v2/TurnInterruptParams.json": ["threadId", "turnId"],
  "v2/TurnCompletedNotification.json": [
    "threadId",
    "turn",
    "id",
    "status",
    "error",
    "items",
    "completed",
    "interrupted",
    "failed",
    "inProgress",
    "message",
    "codexErrorInfo",
    "additionalDetails",
  ],
  "v2/ThreadTokenUsageUpdatedNotification.json": ["threadId", "turnId", "tokenUsage"],
  "codex_app_server_protocol.v2.schemas.json": [
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "cyberPolicy",
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "other",
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "message",
    "codexErrorInfo",
    "additionalDetails",
    "model/rerouted",
    "highRiskCyberActivity",
    "fromModel",
    "toModel",
  ],
};

export async function inspectCodexProtocol(
  options: ProtocolEvidenceOptions,
): Promise<CodexProtocolEvidence> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  throwIfCancelled(options.signal, "startup");
  const deadline = performance.now() + options.timeoutMs;
  const outputRoot = await mkdtemp(join(tmpdir(), "codex-protocol-evidence-"));
  try {
    const prefix = [...(options.prefixArgs ?? [])];
    const version = (await runCodex(options, [...prefix, "--version"], deadline, "version")).trim();
    if (!/^codex-cli \d+\.\d+\.\d+$/.test(version))
      throw new ProtocolEvidenceError(
        "protocol-incompatible",
        "Codex CLI returned an invalid version.",
      );
    throwIfCancelled(options.signal, "generate-ts");
    const typesRoot = join(outputRoot, "types");
    const jsonRoot = join(outputRoot, "json");
    await runCodex(
      options,
      [...prefix, "app-server", "generate-ts", "--out", typesRoot],
      deadline,
      "generate-ts",
    );
    throwIfCancelled(options.signal, "generate-json-schema");
    await runCodex(
      options,
      [...prefix, "app-server", "generate-json-schema", "--out", jsonRoot],
      deadline,
      "generate-json-schema",
    );
    const types = await inspectTree(
      typesRoot,
      ".ts",
      REQUIRED_TS_TOKENS,
      deadline,
      options.signal,
    );
    const jsonSchema = await inspectTree(
      jsonRoot,
      ".json",
      REQUIRED_JSON_TOKENS,
      deadline,
      options.signal,
    );
    return {
      codexCliVersion: version,
      generatedWithoutExperimentalApi: true,
      typesSha256: types.sha256,
      jsonSchemaSha256: jsonSchema.sha256,
      typesFileCount: types.fileCount,
      jsonSchemaFileCount: jsonSchema.fileCount,
    };
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

async function runCodex(
  options: ProtocolEvidenceOptions,
  args: readonly string[],
  deadline: number,
  phase: string,
): Promise<string> {
  throwIfCancelled(options.signal, phase);
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ProtocolTimeoutError(phase);
  const childEnv = buildCodexEnvironment(options.env);
  const executable = await ensureExecutableAvailable(
    options.executable,
    childEnv,
    deadline,
    phase,
    options.signal,
  );
  const commandRemaining = deadline - performance.now();
  if (commandRemaining <= 0) throw new ProtocolTimeoutError(phase);
  try {
    const result = await execa(executable, args, {
      env: childEnv,
      extendEnv: false,
      reject: true,
      timeout: commandRemaining,
      killSignal: "SIGTERM",
      forceKillAfterDelay: 100,
      ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    });
    return result.stdout;
  } catch (error) {
    if (isRecord(error) && error["timedOut"] === true) throw new ProtocolTimeoutError(phase);
    if (options.signal?.aborted) throw new ProtocolCancelledError(phase);
    if (isMissingExecutableError(error)) {
      throw new ProtocolEvidenceError("executable-missing", "Codex CLI executable was not found.");
    }
    const stderr = redactStderr(
      isRecord(error) && typeof error["stderr"] === "string" ? error["stderr"] : "",
      childEnv,
    );
    throw new ProtocolGenerationError(phase, stderr);
  }
}

async function ensureExecutableAvailable(
  executable: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  phase: string,
  signal?: AbortSignal,
): Promise<string> {
  for (const candidate of executableCandidates(executable, env)) {
    throwIfCancelled(signal, phase);
    if (await isFile(candidate, deadline, phase, signal)) return candidate;
  }
  throwIfCancelled(signal, phase);
  throw new ProtocolEvidenceError("executable-missing", "Codex CLI executable was not found.");
}

function executableCandidates(executable: string, env: NodeJS.ProcessEnv): string[] {
  const suffixes = executableSuffixes(executable, env);
  const names = suffixes.map((suffix) => `${executable}${suffix}`);
  if (isPathLike(executable)) return names;
  const pathValue = environmentValue(env, "PATH");
  if (pathValue === undefined) return [];
  return pathValue
    .split(delimiter)
    .flatMap((directory) => names.map((name) => join(directory === "" ? "." : directory, name)));
}

function executableSuffixes(executable: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32" || extname(executable) !== "") return [""];
  const pathExt = environmentValue(env, "PATHEXT");
  const extensions = pathExt?.split(delimiter).filter((extension) => extension !== "") ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  return [
    "",
    ...extensions.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`)),
  ];
}

function isPathLike(executable: string): boolean {
  return isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
}

async function isFile(
  candidate: string,
  deadline: number,
  phase: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    return (await withDeadline(stat(candidate), deadline, phase, signal)).isFile();
  } catch (error) {
    if (error instanceof ProtocolTimeoutError || error instanceof ProtocolCancelledError) throw error;
    return !isMissingPathError(error);
  }
}

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  let value: string | undefined;
  const normalizedKey = key.toUpperCase();
  for (const [name, entry] of Object.entries(env)) {
    if (name.toUpperCase() === normalizedKey && entry !== undefined) value = entry;
  }
  return value;
}

async function inspectTree(
  root: string,
  extension: ".ts" | ".json",
  requiredTokens: Readonly<Record<string, readonly string[]>>,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ sha256: string; fileCount: number }> {
  throwIfCancelled(signal, `inspect-${extension}`);
  const expected = Object.keys(requiredTokens).sort();
  const files = (await listFiles(root, signal, `list-${extension}`)).sort();
  const missing = expected.find((path) => !files.includes(path));
  if (missing !== undefined)
    throw new ProtocolEvidenceError(
      "protocol-incompatible",
      `Generated ${extension} output is missing required path ${missing}.`,
    );
  const hash = createHash("sha256");
  for (const path of files) {
    throwIfCancelled(signal, `hash-${extension}`);
    const bytes = await withDeadline(
      readFile(join(root, path)),
      deadline,
      `hash-${extension}`,
      signal,
    );
    const tokens = requiredTokens[path];
    if (tokens !== undefined) {
      const text = bytes.toString("utf8");
      for (const token of tokens) {
        if (!text.includes(token))
          throw new ProtocolEvidenceError(
            "protocol-incompatible",
            `Generated ${extension} path ${path} is missing token ${token}.`,
          );
      }
    }
    const pathBytes = Buffer.from(path);
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

function throwIfCancelled(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) throw new ProtocolCancelledError(phase);
}

async function listFiles(
  root: string,
  signal: AbortSignal | undefined,
  phase: string,
): Promise<string[]> {
  throwIfCancelled(signal, phase);
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  throwIfCancelled(signal, phase);
  for (const entry of entries) {
    throwIfCancelled(signal, phase);
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const child of await listFiles(path, signal, phase)) {
        result.push(join(entry.name, child));
      }
    } else if (entry.isFile()) {
      result.push(entry.name);
    }
  }
  return result.map((path) => relative(root, join(root, path)).replaceAll("\\", "/"));
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  phase: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfCancelled(signal, phase);
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ProtocolTimeoutError(phase);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new ProtocolCancelledError(phase)));
    const timer = setTimeout(() => finish(() => reject(new ProtocolTimeoutError(phase))), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function redactStderr(stderr: string, env: NodeJS.ProcessEnv | undefined): string {
  let redacted = stderr;
  for (const value of Object.values(env ?? {})) {
    if (value !== undefined && value !== "") redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted.slice(0, 4_096);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingExecutableError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  while (isRecord(current)) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current["code"] === "ENOENT") return true;
    current = current["cause"];
  }
  return false;
}

function isMissingPathError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error["code"] === "ENOENT" || error["code"] === "ENOTDIR";
}
