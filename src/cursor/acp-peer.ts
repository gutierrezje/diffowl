import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { execa, type Options as ExecaOptions } from "execa";
import { buildCursorEnvironment } from "./environment.js";
import {
  isCursorFiniteNumber,
  isCursorJsonObject,
  isCursorJsonValue,
  isCursorText,
  type CursorJsonPayload,
  type CursorJsonValue,
} from "./types.js";

export type AcpRequestId = string | number;
export type AcpPayload = CursorJsonPayload;

export type AcpServerMessage =
  | { kind: "notification"; method: string; params: AcpPayload }
  | { kind: "request"; id: AcpRequestId; method: string; params: AcpPayload };

export type AcpCloseResult = {
  kind: "eof" | "exit" | "sigterm" | "sigkill";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type AcpPeerOptions = {
  executable: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  closeTimeoutMs: number;
};

type AcpRpcError = { code: number; message: string; data?: AcpPayload };

export class AcpPeerError extends Error {
  readonly kind:
    | "malformed-json"
    | "malformed-envelope"
    | "rpc-error"
    | "premature-eof"
    | "process"
    | "executable-missing"
    | "closed";
  readonly id?: AcpRequestId;
  readonly method?: string;
  readonly rpcError?: AcpRpcError;

  constructor(
    kind: AcpPeerError["kind"],
    message: string,
    details: { id?: AcpRequestId; method?: string; rpcError?: AcpRpcError } = {},
  ) {
    super(message);
    this.name = "AcpPeerError";
    this.kind = kind;
    if (details.id !== undefined) this.id = details.id;
    if (details.method !== undefined) this.method = details.method;
    if (details.rpcError !== undefined) this.rpcError = details.rpcError;
  }
}

export type AcpPeer = {
  readonly pid: number | undefined;
  request(
    method: string,
    params?: CursorJsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<AcpPayload>;
  notify(method: string, params?: CursorJsonValue): void;
  respond(id: AcpRequestId, result: CursorJsonValue): void;
  respondError(id: AcpRequestId, code: number, message: string): void;
  nextMessage(options?: { signal?: AbortSignal }): Promise<AcpServerMessage | undefined>;
  close(): Promise<AcpCloseResult>;
};

type Pending = {
  method: string;
  resolve(value: AcpPayload): void;
  reject(cause: unknown): void;
};

type MessageWaiter = {
  resolve(value: AcpServerMessage | undefined): void;
  reject(cause: unknown): void;
};

type Exit = { code: number | null; signal: NodeJS.Signals | null };

type ParsedMessage =
  | { kind: "response"; id: AcpRequestId; result: AcpPayload }
  | { kind: "rpc-error"; id: AcpRequestId; error: AcpRpcError }
  | AcpServerMessage;

export function startAcpPeer(options: AcpPeerOptions): AcpPeer {
  if (!Number.isSafeInteger(options.closeTimeoutMs) || options.closeTimeoutMs <= 0) {
    throw new RangeError("closeTimeoutMs must be a positive safe integer");
  }
  const childEnv = buildCursorEnvironment(options.env);
  const executable = ensureExecutableAvailable(options.executable, childEnv, options.cwd);
  const childOptions = {
    cwd: options.cwd,
    env: childEnv,
    extendEnv: false,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    buffer: false,
    cleanup: false,
    stripFinalNewline: false,
    reject: false,
  } satisfies ExecaOptions;
  const child = execa(executable, [...(options.args ?? [])], childOptions);
  const pending = new Map<AcpRequestId, Pending>();
  const ignoredResponseIds = new Set<AcpRequestId>();
  const messageQueue: AcpServerMessage[] = [];
  const messageWaiters: MessageWaiter[] = [];
  const exitWaiters: Array<(exit: Exit) => void> = [];
  let nextId = 1;
  let terminalError: AcpPeerError | undefined;
  let exit: Exit | undefined;
  let closing = false;
  let exitedBeforeClose = false;
  let stdoutEndedBeforeClose = false;
  let termination: "sigterm" | "sigkill" | undefined;
  let closePromise: Promise<AcpCloseResult> | undefined;

  const rejectAll = (error: AcpPeerError): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    for (const waiter of messageWaiters.splice(0)) waiter.reject(error);
  };
  const fail = (error: AcpPeerError, terminate = true): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    rejectAll(error);
    if (terminate && exit === undefined && !closing && child.kill("SIGTERM")) {
      termination = "sigterm";
    }
  };
  const closedError = (): AcpPeerError =>
    terminalError ?? new AcpPeerError("closed", "Cursor ACP peer is closed.");
  const write = (message: Record<string, AcpPayload>): void => {
    if (terminalError !== undefined || closing) throw closedError();
    if (child.stdin === null) throw new AcpPeerError("process", "Cursor ACP stdin is unavailable.");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const deliver = (message: AcpServerMessage): void => {
    const waiter = messageWaiters.shift();
    if (waiter === undefined) messageQueue.push(message);
    else waiter.resolve(message);
  };
  const handle = (message: ParsedMessage): void => {
    if (message.kind === "notification" || message.kind === "request") {
      deliver(message);
      return;
    }
    const request = pending.get(message.id);
    if (request === undefined) {
      if (ignoredResponseIds.delete(message.id)) return;
      fail(
        new AcpPeerError("malformed-envelope", "Cursor ACP response id is unknown.", {
          id: message.id,
        }),
      );
      return;
    }
    pending.delete(message.id);
    if (message.kind === "response") request.resolve(message.result);
    else {
      request.reject(
        new AcpPeerError("rpc-error", `Cursor ACP request failed: ${request.method}.`, {
          id: message.id,
          method: request.method,
          rpcError: message.error,
        }),
      );
    }
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exit = { code, signal };
    if (!closing) exitedBeforeClose = true;
    for (const resolveExit of exitWaiters.splice(0)) resolveExit(exit);
    if (!closing && terminalError === undefined) {
      fail(new AcpPeerError("premature-eof", "Cursor ACP process ended before close."), false);
    } else if (pending.size > 0 && terminalError === undefined) {
      fail(new AcpPeerError("process", "Cursor ACP process ended with pending requests."), false);
    } else if (terminalError === undefined) {
      for (const waiter of messageWaiters.splice(0)) waiter.resolve(undefined);
    }
  };

  child.once("close", onExit);
  child.once("error", () => {
    fail(new AcpPeerError("process", "Cursor ACP process failed."));
  });
  void (async () => {
    const stdout = child.stdout;
    if (stdout === null) {
      fail(new AcpPeerError("process", "Cursor ACP stdout is unavailable."));
      return;
    }
    try {
      for await (const line of createInterface({ input: stdout, crlfDelay: Infinity })) {
        if (terminalError !== undefined || line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          handle(parseMessage(parsed));
        } catch (error) {
          fail(
            error instanceof AcpPeerError
              ? error
              : new AcpPeerError("malformed-json", "Cursor ACP emitted malformed JSON."),
          );
        }
      }
      if (!closing) {
        stdoutEndedBeforeClose = true;
        fail(new AcpPeerError("premature-eof", "Cursor ACP stdout ended before close."));
      }
    } catch {
      fail(new AcpPeerError("process", "Cursor ACP stdout could not be read."));
    }
  })();

  const waitForExit = (timeoutMs: number): Promise<Exit | undefined> => {
    if (exit !== undefined) return Promise.resolve(exit);
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        const index = exitWaiters.indexOf(onExitResult);
        if (index !== -1) exitWaiters.splice(index, 1);
        resolveExit(undefined);
      }, timeoutMs);
      const onExitResult = (result: Exit): void => {
        clearTimeout(timer);
        resolveExit(result);
      };
      exitWaiters.push(onExitResult);
    });
  };
  const close = async (): Promise<AcpCloseResult> => {
    closing = true;
    const deadline = performance.now() + options.closeTimeoutMs;
    const waitStage = (): Promise<Exit | undefined> => {
      const remaining = deadline - performance.now();
      return remaining <= 0
        ? Promise.resolve(undefined)
        : waitForExit(Math.min(remaining, options.closeTimeoutMs / 3));
    };
    try {
      child.stdin?.end();
    } catch {
      // The process may close stdin concurrently.
    }
    let finalExit = await waitStage();
    if (finalExit === undefined) {
      if (child.kill("SIGTERM")) termination = "sigterm";
      finalExit = await waitStage();
    }
    if (finalExit === undefined) {
      if (child.kill("SIGKILL")) termination = "sigkill";
      finalExit = await waitForExit(Math.max(10, options.closeTimeoutMs / 3));
    }
    if (finalExit === undefined) {
      throw new AcpPeerError("process", "Cursor ACP process did not exit after SIGKILL.");
    }
    return {
      kind: termination ?? (exitedBeforeClose || stdoutEndedBeforeClose ? "exit" : "eof"),
      ...finalExit,
    };
  };

  return {
    pid: child.pid,
    request(method, params, requestOptions) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        const signal = requestOptions?.signal;
        const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
        const settleResolve = (value: AcpPayload): void => {
          cleanup();
          resolveRequest(value);
        };
        const settleReject = (cause: unknown): void => {
          cleanup();
          rejectRequest(cause);
        };
        const onAbort = (): void => {
          pending.delete(id);
          ignoredResponseIds.add(id);
          settleReject(signal?.reason ?? new Error("Cursor ACP request aborted."));
        };
        pending.set(id, { method, resolve: settleResolve, reject: settleReject });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const request = params === undefined ? { id, method } : { id, method, params };
          write(request);
        } catch (error) {
          pending.delete(id);
          settleReject(error);
          fail(
            error instanceof AcpPeerError
              ? error
              : new AcpPeerError("process", "Cursor ACP request could not be sent."),
          );
        }
      });
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    respond(id, result) {
      write({ id, result });
    },
    respondError(id, code, message) {
      write({ id, error: { code, message } });
    },
    nextMessage(messageOptions) {
      const next = messageQueue.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (terminalError !== undefined) return Promise.reject(terminalError);
      if (exit !== undefined) return Promise.resolve(undefined);
      return new Promise((resolveMessage, rejectMessage) => {
        const signal = messageOptions?.signal;
        let waiter: MessageWaiter;
        const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
        const onAbort = (): void => {
          const index = messageWaiters.indexOf(waiter);
          if (index !== -1) messageWaiters.splice(index, 1);
          cleanup();
          rejectMessage(signal?.reason ?? new Error("Cursor ACP message wait aborted."));
        };
        waiter = {
          resolve(value) {
            cleanup();
            resolveMessage(value);
          },
          reject(cause) {
            cleanup();
            rejectMessage(cause);
          },
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        messageWaiters.push(waiter);
      });
    },
    close() {
      return (closePromise ??= close());
    },
  };
}

function parseMessage(cause: unknown): ParsedMessage {
  if (!isCursorJsonObject(cause)) {
    throw new AcpPeerError("malformed-envelope", "Cursor ACP message must be an object.");
  }
  if (cause["jsonrpc"] !== "2.0") {
    throw new AcpPeerError("malformed-envelope", "Cursor ACP jsonrpc version is invalid.");
  }
  const hasId = Object.hasOwn(cause, "id");
  const id = hasId ? parseId(cause["id"]) : undefined;
  const method = cause["method"];
  if (method !== undefined) {
    if (!isCursorText(method) || method === "") {
      throw new AcpPeerError("malformed-envelope", "Cursor ACP method is invalid.");
    }
    const params = jsonPayload(cause["params"]);
    return id === undefined
      ? { kind: "notification", method, params }
      : { kind: "request", id, method, params };
  }
  if (id === undefined) {
    throw new AcpPeerError("malformed-envelope", "Cursor ACP response id is missing.");
  }
  if (Object.hasOwn(cause, "result")) {
    return { kind: "response", id, result: jsonPayload(cause["result"]) };
  }
  const rpcError = cause["error"];
  if (isRpcError(rpcError)) return { kind: "rpc-error", id, error: rpcError };
  throw new AcpPeerError("malformed-envelope", "Cursor ACP response shape is invalid.");
}

function jsonPayload(cause: unknown): AcpPayload {
  if (cause === undefined || isCursorJsonValue(cause)) return cause;
  throw new AcpPeerError("malformed-envelope", "Cursor ACP payload is not JSON.");
}

function isRpcError(cause: unknown): cause is AcpRpcError {
  return (
    isCursorJsonObject(cause) &&
    isCursorFiniteNumber(cause["code"]) &&
    isCursorText(cause["message"]) &&
    (cause["data"] === undefined || isCursorJsonValue(cause["data"]))
  );
}

function parseId(cause: unknown): AcpRequestId {
  if (isCursorText(cause) && cause !== "") return cause;
  if (isCursorFiniteNumber(cause) && Number.isSafeInteger(cause)) return cause;
  throw new AcpPeerError("malformed-envelope", "Cursor ACP message id is invalid.");
}

function ensureExecutableAvailable(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  for (const candidate of executableCandidates(executable, env, cwd)) {
    try {
      if (!statSync(candidate).isFile()) continue;
      if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new AcpPeerError("executable-missing", "Cursor ACP executable was not found.");
}

function executableCandidates(executable: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const suffixes = executableSuffixes(executable, env);
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    return suffixes.map((suffix) => resolve(cwd, `${executable}${suffix}`));
  }
  const path = environmentValue(env, "PATH");
  if (path === undefined) return [];
  return path
    .split(delimiter)
    .flatMap((directory) =>
      suffixes.map((suffix) => resolve(cwd, join(directory || ".", `${executable}${suffix}`))),
    );
}

function executableSuffixes(executable: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32" || extname(executable) !== "") return [""];
  const pathExt = environmentValue(env, "PATHEXT");
  const extensions = pathExt?.split(delimiter).filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"];
  return ["", ...extensions.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))];
}

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const normalized = key.toUpperCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === normalized) return value;
  }
  return undefined;
}
