import type { ReviewContextDepth } from "../config.js";
import type { ReviewOptions } from "./client.js";

type ToolPolicy = Record<string, boolean>;
type PermissionResponse = "once" | "always" | "reject";

const FALLBACK_TOOL_IDS = [
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "write",
];

const READ_SEARCH_TOOLS = new Set(["glob", "grep", "read"]);
const PERMISSION_REPLY_TIMEOUT_MS = 5_000;

export interface PermissionRequest {
  id: string;
  sessionID: string;
  type: string;
  title?: string;
}

export async function buildToolPolicy(
  client: { tool?: { ids?: () => Promise<{ data: unknown }> } },
  depth: ReviewContextDepth,
): Promise<ToolPolicy> {
  const available = new Set(FALLBACK_TOOL_IDS);
  try {
    const result = await client.tool?.ids?.();
    if (Array.isArray(result?.data)) {
      for (const id of result.data) {
        if (typeof id === "string") {
          available.add(id);
        }
      }
    }
  } catch {
    // Fall back to known OpenCode built-ins. Unknown tools remain unavailable by omission.
  }

  const allowed = allowedToolsForDepth(depth);
  const policy: ToolPolicy = {};
  for (const id of available) {
    policy[id] = allowed.has(id);
  }
  return policy;
}

function allowedToolsForDepth(depth: ReviewContextDepth): Set<string> {
  if (depth === "shallow") {
    return new Set();
  }
  return READ_SEARCH_TOOLS;
}

export async function replyToPermissionRequest(
  client: {
    postSessionIdPermissionsPermissionId?: (options: {
      path: { id: string; permissionID: string };
      body: { response: "once" | "always" | "reject" };
    }) => Promise<unknown>;
    permission?: {
      reply?: (
        path: { requestID: string },
        options?: { body?: { reply: "once" | "always" | "reject"; message?: string } },
      ) => Promise<unknown>;
    };
  },
  permission: PermissionRequest,
  onProgress: ReviewOptions["onProgress"],
): Promise<void> {
  // Reviews may use permissionless read/search tools from the prompt tool policy,
  // but any OpenCode permission prompt is treated as an escalation and rejected.
  const response: PermissionResponse = "reject";
  onProgress?.({
    type: "session",
    message: `OpenCode permission ${response}: ${permission.title ?? permission.type}`,
    sessionId: permission.sessionID,
  });

  await withTimeout(
    replyWithAvailableEndpoint(client, permission, response),
    PERMISSION_REPLY_TIMEOUT_MS,
  );
}

async function replyWithAvailableEndpoint(
  client: {
    postSessionIdPermissionsPermissionId?: (options: {
      path: { id: string; permissionID: string };
      body: { response: "once" | "always" | "reject" };
    }) => Promise<unknown>;
    permission?: {
      reply?: (
        path: { requestID: string },
        options?: { body?: { reply: "once" | "always" | "reject"; message?: string } },
      ) => Promise<unknown>;
    };
  },
  permission: PermissionRequest,
  response: PermissionResponse,
): Promise<void> {
  if (client.permission?.reply) {
    await client.permission.reply(
      { requestID: permission.id },
      { body: { reply: response, message: "DiffOwl review depth policy" } },
    );
    return;
  }

  if (client.postSessionIdPermissionsPermissionId) {
    await client.postSessionIdPermissionsPermissionId({
      path: { id: permission.sessionID, permissionID: permission.id },
      body: { response },
    });
  }
}

export function extractPermissionRequest(
  payload: unknown,
  expectedSessionId?: string,
): PermissionRequest | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const event = payload as { type?: unknown; properties?: unknown };
  if (typeof event.type !== "string" || !event.properties || typeof event.properties !== "object") {
    return undefined;
  }

  const properties = event.properties as Record<string, unknown>;
  const sessionId = properties["sessionID"];
  if (
    typeof sessionId !== "string" ||
    (expectedSessionId !== undefined && sessionId !== expectedSessionId)
  ) {
    return undefined;
  }

  if (event.type === "permission.updated") {
    const id = properties["id"];
    const type = properties["type"];
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof type !== "string" ||
      type.trim() === ""
    ) {
      return undefined;
    }

    const title = properties["title"];
    return {
      id,
      sessionID: sessionId,
      type,
      ...(typeof title === "string" ? { title } : {}),
    };
  }

  if (event.type === "permission.asked") {
    const id = properties["id"];
    const permission = properties["permission"];
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof permission !== "string" ||
      permission.trim() === ""
    ) {
      return undefined;
    }

    const patterns = properties["patterns"];
    return {
      id,
      sessionID: sessionId,
      type: permission,
      ...(Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string")
        ? { title: patterns.join(", ") }
        : {}),
    };
  }

  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("permission reply timed out")), ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
