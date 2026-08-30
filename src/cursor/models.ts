import { realpath } from "node:fs/promises";
import { startAcpPeer, type AcpPayload } from "./acp-peer.js";
import { CursorTimeoutError } from "./errors.js";
import {
  initializeCursorConnection,
  parseCursorDiscoveredModels,
  type CursorDiscoveredModel,
  type CursorRequest,
} from "./handshake.js";
import type { CursorJsonValue } from "./types.js";

export type CursorModelDiscoveryOptions = {
  command: {
    executable: string;
    prefixArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
  };
  directory: string;
  timeoutMs: number;
  closeTimeoutMs: number;
};

export async function getAvailableCursorModels(
  options: CursorModelDiscoveryOptions,
): Promise<CursorDiscoveredModel[]> {
  const deadline = performance.now() + options.timeoutMs;
  const directory = await realpath(options.directory);
  const peerOptions: Parameters<typeof startAcpPeer>[0] = {
    executable: options.command.executable,
    args: [...(options.command.prefixArgs ?? []), "acp"],
    cwd: directory,
    closeTimeoutMs: options.closeTimeoutMs,
  };
  if (options.command.env !== undefined) peerOptions.env = options.command.env;
  const peer = startAcpPeer(peerOptions);
  const request: CursorRequest = (method, params, phase) =>
    requestWithin(peer.request.bind(peer), method, params, deadline, phase);

  try {
    await initializeCursorConnection(request);
    return parseCursorDiscoveredModels(
      await request("cursor/list_available_models", {}, "cursor/list_available_models"),
    );
  } finally {
    await peer.close();
  }
}

function requestWithin(
  request: (
    method: string,
    params: CursorJsonValue,
    options: { signal: AbortSignal },
  ) => Promise<AcpPayload>,
  method: string,
  params: CursorJsonValue,
  deadline: number,
  phase: string,
): Promise<AcpPayload> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new CursorTimeoutError(phase));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CursorTimeoutError(phase)), remaining);
  return request(method, params, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
