import { z } from "zod";
import type { ReviewContextDepth } from "../config.js";
import type { ReviewOptions } from "../review/types.js";
import {
  BoundaryValueSchema,
  OpenCodePayloadSchema,
  type OpenCodePayload,
  type OpenCodePayloadInput,
} from "./wire.js";

type ToolPolicy = Record<string, boolean>;
type PermissionResponse = "once" | "always" | "reject";

type ToolIdsResult = z.input<typeof ToolIdsResultSchema>;
type ToolClient = { tool?: { ids?: () => Promise<ToolIdsResult> } };
type PermissionClient = {
  postSessionIdPermissionsPermissionId?: (options: {
    path: { id: string; permissionID: string };
    body: { response: PermissionResponse };
  }) => Promise<object>;
  permission?: {
    reply?: (
      path: { requestID: string },
      options?: { body?: { reply: PermissionResponse; message?: string } },
    ) => Promise<object>;
  };
};

const ToolIdsResultSchema = z
  .object({ data: z.array(BoundaryValueSchema).optional() })
  .passthrough();

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
  client: ToolClient,
  depth: ReviewContextDepth,
): Promise<ToolPolicy> {
  const available = new Set(FALLBACK_TOOL_IDS);
  try {
    const result = await client.tool?.ids?.();
    const parsedResult = ToolIdsResultSchema.safeParse(result);
    if (parsedResult.success) {
      for (const id of parsedResult.data.data ?? []) {
        const parsedId = z.string().safeParse(id);
        if (parsedId.success) {
          available.add(parsedId.data);
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
  client: PermissionClient,
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
  client: PermissionClient,
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
  payload: OpenCodePayloadInput,
  expectedSessionId?: string,
): PermissionRequest | undefined {
  const parsedPayload = OpenCodePayloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return undefined;
  }

  return extractPermissionRequestFromPayload(parsedPayload.data, expectedSessionId);
}

export function extractPermissionRequestFromPayload(
  payload: OpenCodePayload,
  expectedSessionId?: string,
): PermissionRequest | undefined {
  const { type, properties } = payload;

  const parsedSessionId = z.string().safeParse(properties["sessionID"]);
  if (!parsedSessionId.success) {
    return undefined;
  }
  const sessionId = parsedSessionId.data;
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    return undefined;
  }

  if (type === "permission.updated") {
    const id = z.string().safeParse(properties["id"]);
    const permissionType = z.string().safeParse(properties["type"]);
    if (
      !id.success ||
      id.data.trim() === "" ||
      !permissionType.success ||
      permissionType.data.trim() === ""
    ) {
      return undefined;
    }

    const request: PermissionRequest = {
      id: id.data,
      sessionID: sessionId,
      type: permissionType.data,
    };
    const title = z.string().safeParse(properties["title"]);
    if (title.success) request.title = title.data;
    return request;
  }

  if (type === "permission.asked") {
    const id = z.string().safeParse(properties["id"]);
    const permission = z.string().safeParse(properties["permission"]);
    if (
      !id.success ||
      id.data.trim() === "" ||
      !permission.success ||
      permission.data.trim() === ""
    ) {
      return undefined;
    }

    const request: PermissionRequest = {
      id: id.data,
      sessionID: sessionId,
      type: permission.data,
    };
    const patterns = z.array(z.string()).safeParse(properties["patterns"]);
    if (patterns.success) request.title = patterns.data.join(", ");
    return request;
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
