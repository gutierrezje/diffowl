import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import { createInterface } from "node:readline";

const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

export type AppServerPeerOptions = {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extendEnv?: boolean;
  stderrMaxBytes?: number;
  stderrRedactions?: readonly string[];
  closeTimeoutMs?: number;
};

export type AppServerNotification = {
  kind: "notification";
  method: string;
  params: unknown;
};

type AppServerResponse =
  | { kind: "response"; id: AppServerRequestId; result: unknown }
  | { kind: "rpc-error"; id: AppServerRequestId; error: AppServerRpcError };

export type AppServerRequestId = string | number;

export type AppServerRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type AppServerRequest = {
  kind: "request";
  id: AppServerRequestId;
  method: string;
  params: unknown;
};

type AppServerMessage = AppServerResponse | AppServerNotification | AppServerRequest;

type AppServerPeerErrorKind =
  | "malformed-json"
  | "malformed-envelope"
  | "rpc-error"
  | "unexpected-server-request"
  | "premature-eof"
  | "process"
  | "executable-missing"
  | "closed";

export class AppServerPeerError extends Error {
  readonly kind: AppServerPeerErrorKind;
  readonly id?: AppServerRequestId;
  readonly method?: string;
  readonly rpcError?: AppServerRpcError;

  constructor(
    kind: AppServerPeerErrorKind,
    message: string,
    details: { id?: AppServerRequestId; method?: string; rpcError?: AppServerRpcError } = {},
  ) {
    super(message);
    this.name = "AppServerPeerError";
    this.kind = kind;
    if (details.id !== undefined) this.id = details.id;
    if (details.method !== undefined) this.method = details.method;
    if (details.rpcError !== undefined) this.rpcError = details.rpcError;
  }
}

export type AppServerCloseResult = {
  kind: "eof" | "exit" | "sigterm" | "sigkill";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type AppServerPeer = {
  readonly pid: number | undefined;
  request(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  nextNotification(): Promise<AppServerNotification | undefined>;
  getStderr(): string;
  close(): Promise<AppServerCloseResult>;
};

type Pending = { method: string; resolve(value: unknown): void; reject(reason: unknown): void };
type NotificationWaiter = {
  resolve(value: AppServerNotification | undefined): void;
  reject(reason: unknown): void;
};
type Exit = { code: number | null; signal: NodeJS.Signals | null };

export function startAppServerPeer(options: AppServerPeerOptions): AppServerPeer {
  const stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(stderrMaxBytes) || stderrMaxBytes < 0) {
    throw new RangeError("stderrMaxBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new RangeError("closeTimeoutMs must be a positive safe integer");
  }

  const childEnv =
    options.env === undefined
      ? process.env
      : options.extendEnv === false
        ? options.env
        : { ...process.env, ...options.env };
  const executable = ensureExecutableAvailable(
    options.executable,
    childEnv,
    options.cwd ?? process.cwd(),
  );

  const child = execa(executable, [...(options.args ?? [])], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: childEnv, extendEnv: false }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    buffer: false,
    stripFinalNewline: false,
    reject: false,
  });
  const pending = new Map<AppServerRequestId, Pending>();
  const ignoredResponseIds = new Set<AppServerRequestId>();
  const notificationQueue: AppServerNotification[] = [];
  const notificationWaiters: NotificationWaiter[] = [];
  const exitWaiters: Array<(exit: Exit) => void> = [];
  let nextId = 1;
  let stderr = Buffer.alloc(0);
  let terminalError: AppServerPeerError | undefined;
  let exit: Exit | undefined;
  let exitedBeforeClose = false;
  let stdoutEndedBeforeClose = false;
  let closing = false;
  let termination: "sigterm" | "sigkill" | undefined;
  let closePromise: Promise<AppServerCloseResult> | undefined;

  const rejectAll = (error: AppServerPeerError): void => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    for (const { reject } of notificationWaiters.splice(0)) reject(error);
  };
  const fail = (error: AppServerPeerError, terminate = true): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    rejectAll(error);
    if (terminate && exit === undefined && !closing) {
      if (child.kill("SIGTERM")) termination = "sigterm";
    }
  };
  const closedError = (): AppServerPeerError =>
    terminalError ?? new AppServerPeerError("closed", "App Server peer is closed.");
  const write = (message: Record<string, unknown>): void => {
    if (terminalError !== undefined || closing) throw closedError();
    const stdin = child.stdin;
    if (stdin === null) throw new AppServerPeerError("process", "App Server stdin is unavailable.");
    stdin.write(`${JSON.stringify(message)}\n`);
  };
  const parse = (raw: unknown): AppServerMessage => {
    if (!isRecord(raw)) {
      throw new AppServerPeerError("malformed-envelope", "App Server message must be an object.");
    }
    const message = raw;
    const hasId = Object.hasOwn(message, "id");
    const id = hasId ? parseId(message["id"]) : undefined;
    if (Object.hasOwn(message, "method")) {
      const method = message["method"];
      if (typeof method !== "string") {
        throw new AppServerPeerError("malformed-envelope", "App Server method is invalid.");
      }
      if (id !== undefined) {
        return {
          kind: "request",
          id,
          method,
          params: message["params"],
        };
      }
      return { kind: "notification", method, params: message["params"] };
    }
    if (id === undefined) {
      throw new AppServerPeerError("malformed-envelope", "App Server response id is missing.");
    }
    if (Object.hasOwn(message, "result")) {
      return { kind: "response", id, result: message["result"] };
    }
    const error = message["error"];
    if (Object.hasOwn(message, "error") && isRpcError(error)) {
      return { kind: "rpc-error", id, error };
    }
    throw new AppServerPeerError("malformed-envelope", "App Server response shape is invalid.");
  };
  const handle = (message: AppServerMessage): void => {
    if (message.kind === "notification") {
      const waiter = notificationWaiters.shift();
      if (waiter === undefined) notificationQueue.push(message);
      else waiter.resolve(message);
      return;
    }
    if (message.kind === "request") {
      fail(
        new AppServerPeerError(
          "unexpected-server-request",
          "App Server sent an unexpected request.",
          { id: message.id, method: message.method },
        ),
      );
      return;
    }
    const request = pending.get(message.id);
    if (request === undefined) {
      if (ignoredResponseIds.delete(message.id)) return;
      fail(
        new AppServerPeerError("malformed-envelope", "App Server response id is unknown.", {
          id: message.id,
        }),
      );
      return;
    }
    pending.delete(message.id);
    if (message.kind === "response") request.resolve(message.result);
    else
      request.reject(
        new AppServerPeerError("rpc-error", "App Server request failed.", {
          id: message.id,
          method: request.method,
          rpcError: message.error,
        }),
      );
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exit = { code, signal };
    if (!closing) exitedBeforeClose = true;
    for (const resolve of exitWaiters.splice(0)) resolve(exit);
    if (!closing && terminalError === undefined) {
      fail(
        new AppServerPeerError("premature-eof", "App Server process ended before close."),
        false,
      );
    } else if (closing && pending.size > 0) {
      fail(new AppServerPeerError("process", "App Server process ended with pending requests."));
    }
    if (terminalError === undefined) {
      for (const { resolve } of notificationWaiters.splice(0)) resolve(undefined);
    }
  };
  child.once("close", onExit);
  child.once("error", (error: NodeJS.ErrnoException) => {
    const missing = hasErrorCode(error, "ENOENT") && hasUsableCwd(options.cwd);
    fail(
      new AppServerPeerError(
        missing ? "executable-missing" : "process",
        missing ? "App Server executable was not found." : "App Server process failed.",
      ),
    );
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (stderr.length < stderrMaxBytes)
      stderr = Buffer.concat([stderr, bytes.subarray(0, stderrMaxBytes - stderr.length)]);
  });
  void (async () => {
    const stdout = child.stdout;
    if (stdout === null) {
      fail(new AppServerPeerError("process", "App Server stdout is unavailable."));
      return;
    }
    try {
      for await (const line of createInterface({ input: stdout, crlfDelay: Infinity })) {
        if (terminalError !== undefined) continue;
        try {
          handle(parse(JSON.parse(line)));
        } catch (error) {
          fail(
            error instanceof AppServerPeerError
              ? error
              : new AppServerPeerError("malformed-json", "App Server emitted malformed JSON."),
          );
        }
      }
      if (!closing) {
        stdoutEndedBeforeClose = true;
        fail(new AppServerPeerError("premature-eof", "App Server stdout ended before close."));
      }
    } catch {
      fail(new AppServerPeerError("process", "App Server stdout could not be read."));
    }
  })();
  void child.then(
    (result) => {
      if (!result.failed || terminalError !== undefined || exit !== undefined) return;
      const missing = hasErrorCode(result, "ENOENT") && hasUsableCwd(options.cwd);
      fail(
        new AppServerPeerError(
          missing ? "executable-missing" : "process",
          missing ? "App Server executable was not found." : "App Server process failed.",
        ),
      );
    },
    () => {
      if (terminalError === undefined && exit === undefined)
        fail(new AppServerPeerError("process", "App Server process failed."));
    },
  );

  const waitForExit = (timeoutMs: number): Promise<Exit | undefined> => {
    if (exit !== undefined) return Promise.resolve(exit);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = exitWaiters.indexOf(onExitResult);
        if (index !== -1) exitWaiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      const onExitResult = (result: Exit): void => {
        clearTimeout(timer);
        resolve(result);
      };
      exitWaiters.push(onExitResult);
    });
  };
  const closePeer = async (): Promise<AppServerCloseResult> => {
    closing = true;
    const deadline = performance.now() + closeTimeoutMs;
    const waitStage = async (): Promise<Exit | undefined> => {
      const remaining = deadline - performance.now();
      return remaining > 0 ? waitForExit(Math.min(remaining, closeTimeoutMs / 3)) : undefined;
    };
    try {
      child.stdin?.end();
    } catch {
      // The process may have closed stdin concurrently.
    }
    let finalExit = await waitStage();
    if (finalExit === undefined) {
      if (child.kill("SIGTERM")) termination = "sigterm";
      finalExit = await waitStage();
    }
    if (finalExit === undefined) {
      if (child.kill("SIGKILL")) termination = "sigkill";
      finalExit = await waitForExit(Math.max(10, closeTimeoutMs / 3));
    }
    if (finalExit === undefined)
      throw new AppServerPeerError("process", "App Server did not exit after SIGKILL.");
    const kind = termination ?? (exitedBeforeClose || stdoutEndedBeforeClose ? "exit" : "eof");
    return { kind, ...finalExit };
  };
  return {
    pid: child.pid,
    request(method, params, requestOptions) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const signal = requestOptions?.signal;
        const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
        const settleResolve = (value: unknown): void => {
          cleanup();
          resolve(value);
        };
        const settleReject = (reason: unknown): void => {
          cleanup();
          reject(reason);
        };
        const onAbort = (): void => {
          pending.delete(id);
          ignoredResponseIds.add(id);
          settleReject(signal?.reason ?? new Error("App Server request aborted."));
        };
        pending.set(id, { method, resolve: settleResolve, reject: settleReject });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          write({ id, method, ...(params === undefined ? {} : { params }) });
        } catch (error) {
          pending.delete(id);
          settleReject(error);
          fail(
            error instanceof AppServerPeerError
              ? error
              : new AppServerPeerError("process", "App Server request could not be sent."),
          );
        }
      });
    },
    notify(method, params) {
      write({ method, ...(params === undefined ? {} : { params }) });
    },
    nextNotification() {
      const next = notificationQueue.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (terminalError !== undefined) return Promise.reject(terminalError);
      if (exit !== undefined) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => notificationWaiters.push({ resolve, reject }));
    },
    getStderr: () => redact(stderr.toString("utf8"), options.stderrRedactions ?? []),
    close() {
      return (closePromise ??= closePeer());
    },
  };
}

function isRpcError(value: unknown): value is AppServerRpcError {
  if (!isRecord(value)) return false;
  const code = value["code"];
  const message = value["message"];
  return typeof code === "number" && Number.isFinite(code) && typeof message === "string";
}

function parseId(value: unknown): AppServerRequestId {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppServerPeerError("malformed-envelope", "App Server message id is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret !== "") result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function hasUsableCwd(cwd: string | undefined): boolean {
  if (cwd === undefined) return true;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function ensureExecutableAvailable(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  for (const candidate of executableCandidates(executable, env, cwd)) {
    if (isExistingFile(candidate)) return candidate;
  }
  throw new AppServerPeerError("executable-missing", "App Server executable was not found.");
}

function executableCandidates(executable: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const suffixes = executableSuffixes(executable, env);
  const names = suffixes.map((suffix) => resolveCandidate(`${executable}${suffix}`, cwd));
  if (isPathLike(executable)) return names;
  const pathValue = environmentValue(env, "PATH");
  if (pathValue === undefined) return [];
  return pathValue
    .split(delimiter)
    .flatMap((directory) =>
      suffixes.map((suffix) =>
        resolveCandidate(join(directory === "" ? "." : directory, `${executable}${suffix}`), cwd),
      ),
    );
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

function resolveCandidate(candidate: string, cwd: string): string {
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

function isExistingFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  let value: string | undefined;
  let found = false;
  const normalizedKey = key.toUpperCase();
  for (const [name, entry] of Object.entries(env)) {
    if (name.toUpperCase() === normalizedKey) {
      found = true;
      value = entry;
    }
  }
  return found ? value : undefined;
}

function hasErrorCode(value: unknown, code: string): boolean {
  let current: unknown = value;
  const seen = new Set<object>();
  while (isRecord(current)) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current["code"] === code) return true;
    current = current["cause"];
  }
  return false;
}
