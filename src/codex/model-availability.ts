import { startAppServerPeer, type AppServerPeer } from "./app-server-peer.js";
import { buildCodexEnvironment } from "./environment.js";
import { codexProtocolError } from "./errors.js";
import { isRecord, isText, type CodexJsonObject, type CodexJsonValue } from "./types.js";
import packageJson from "../../package.json" with { type: "json" };

export type CodexModelAvailability = "available" | "not-advertised" | "not-chatgpt" | "unverified";
export type ModelListParams = { includeHidden: true; limit: 100; cursor?: string };

export function formatMissingCodexModelWarning(model: string): string {
  return `Codex does not advertise model "${model}" for this CLI and ChatGPT account. Reviews may fail. Update Codex or open \`codex\` and run \`/model\` to choose an available model.`;
}

export async function findCodexModel(
  model: string,
  requestModelList: (params: ModelListParams) => Promise<CodexJsonValue | undefined>,
): Promise<CodexJsonObject | null> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const params: ModelListParams =
      cursor === undefined
        ? { includeHidden: true, limit: 100 }
        : { includeHidden: true, limit: 100, cursor };
    const response = await requestModelList(params);
    if (!isRecord(response) || !Array.isArray(response["data"])) {
      throw codexProtocolError("model/list.data");
    }
    const selected = response["data"].find(
      (entry) => isRecord(entry) && (entry["id"] === model || entry["model"] === model),
    );
    if (isRecord(selected)) return selected;
    const nextCursor = response["nextCursor"];
    if (nextCursor === null) return null;
    if (!isText(nextCursor) || nextCursor === "" || seenCursors.has(nextCursor)) {
      throw codexProtocolError("model/list.nextCursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

/** Check the current account's model catalog without starting a model turn. */
export async function inspectCodexModelAvailability(model: string): Promise<CodexModelAvailability> {
  let peer: AppServerPeer | undefined;
  try {
    peer = startAppServerPeer({
      executable: process.env["DIFFOWL_CODEX_EXECUTABLE"]?.trim() || "codex",
      args: ["app-server", "--stdio"],
      env: buildCodexEnvironment(),
      extendEnv: false,
    });
    const signal = AbortSignal.timeout(2_500);
    await peer.request(
      "initialize",
      {
        clientInfo: { name: "diffowl", title: "DiffOwl", version: packageJson.version },
        capabilities: null,
      },
      { signal },
    );
    peer.notify("initialized");
    const account = await peer.request("account/read", { refreshToken: false }, { signal });
    const accountValue = isRecord(account) ? account["account"] : undefined;
    if (accountValue === null) return "not-chatgpt";
    if (!isRecord(accountValue) || !isText(accountValue["type"])) return "unverified";
    if (accountValue["type"] !== "chatgpt") return "not-chatgpt";

    const activePeer = peer;
    const selected = await findCodexModel(model, (params) =>
      activePeer.request("model/list", params, { signal }),
    );
    return selected === null ? "not-advertised" : "available";
  } catch {
    return "unverified";
  } finally {
    await peer?.close().catch(() => undefined);
  }
}
