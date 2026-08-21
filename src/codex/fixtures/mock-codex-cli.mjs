import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--experimental")) process.exit(2);
if (process.env.MOCK_CLI_COMMAND_LOG)
  await appendFile(process.env.MOCK_CLI_COMMAND_LOG, `${args.join(" ")}\n`);
if (process.env.MOCK_CLI_PID_FILE)
  await writeFile(process.env.MOCK_CLI_PID_FILE, `${process.pid}\n`);

if (args.length === 2 && args[0] === "app-server" && args[1] === "--stdio") {
  await import("./mock-app-server.mjs");
  await new Promise(() => {});
}

const tsFiles = {
  "ClientNotification.ts": "initialized\n",
  "ClientRequest.ts": "initialize account/read thread/start turn/start turn/interrupt\n",
  "ServerNotification.ts":
    "item/completed turn/completed thread/tokenUsage/updated item/agentMessage/delta model/rerouted\n",
  "v2/AgentMessageDeltaNotification.ts": "threadId turnId itemId delta\n",
  "v2/ItemCompletedNotification.ts": "threadId turnId item completedAtMs\n",
  "v2/GetAccountParams.ts": "refreshToken\n",
  "v2/GetAccountResponse.ts": "account requiresOpenaiAuth\n",
  "v2/ThreadStartParams.ts": "approvalPolicy sandbox\n",
  "v2/ThreadStartResponse.ts": "thread model modelProvider cwd approvalPolicy sandbox\n",
  "v2/TurnStartParams.ts": "threadId outputSchema approvalPolicy sandboxPolicy\n",
  "v2/TurnStartResponse.ts": "turn\n",
  "v2/TurnInterruptParams.ts": "threadId turnId\n",
  "v2/TurnCompletedNotification.ts":
    "threadId turn id status error items completed interrupted failed inProgress message codexErrorInfo additionalDetails\n",
  "v2/ThreadTokenUsageUpdatedNotification.ts": "threadId turnId\n",
  "v2/ThreadTokenUsage.ts": "total last\n",
  "v2/TokenUsageBreakdown.ts":
    "totalTokens inputTokens cachedInputTokens cacheWriteInputTokens outputTokens reasoningOutputTokens\n",
  "v2/TurnError.ts": "message codexErrorInfo additionalDetails\n",
  "v2/CodexErrorInfo.ts": "contextWindowExceeded httpConnectionFailed other\n",
  "v2/ModelReroutedNotification.ts": "threadId turnId fromModel toModel reason\n",
  "v2/ModelRerouteReason.ts": "highRiskCyberActivity\n",
  "v2/AskForApproval.ts": "never\n",
  "v2/SandboxMode.ts": "read-only\n",
  "v2/SandboxPolicy.ts": "readOnly\n",
  "v2/Turn.ts": "id status error items\n",
  "v2/TurnStatus.ts": "completed interrupted failed inProgress\n",
};

const stringSchema = { type: "string" };
const booleanSchema = { type: "boolean" };
const numberSchema = { type: "integer" };
const sandboxPolicySchema = objectSchema("readOnly networkAccess", {
  type: { type: "string", enum: ["readOnly"] },
  networkAccess: booleanSchema,
});
const turnSchema = objectSchema("id status error items completed interrupted failed inProgress", {
  id: stringSchema,
  status: {
    type: "string",
    enum: ["completed", "interrupted", "failed", "inProgress"],
  },
  error: {
    description: "message codexErrorInfo additionalDetails",
    type: ["object", "null"],
  },
  items: { type: "array" },
});
const jsonFiles = {
  "ClientNotification.json": methodSchema("initialized", ["initialized"]),
  "ClientRequest.json": methodSchema(
    "initialize account/read thread/start turn/start turn/interrupt",
    ["initialize", "account/read", "thread/start", "turn/start", "turn/interrupt"],
  ),
  "ServerNotification.json": methodSchema(
    "item/completed turn/completed thread/tokenUsage/updated item/agentMessage/delta model/rerouted",
    [
      "item/completed",
      "turn/completed",
      "thread/tokenUsage/updated",
      "item/agentMessage/delta",
      "model/rerouted",
    ],
  ),
  "v2/AgentMessageDeltaNotification.json": objectSchema("threadId turnId itemId delta", {
    threadId: stringSchema,
    turnId: stringSchema,
    itemId: stringSchema,
    delta: stringSchema,
  }),
  "v2/ItemCompletedNotification.json": objectSchema("threadId turnId item completedAtMs", {
    threadId: stringSchema,
    turnId: stringSchema,
    item: { type: "object" },
  }),
  "v2/GetAccountParams.json": objectSchema("refreshToken", {
    refreshToken: booleanSchema,
  }),
  "v2/GetAccountResponse.json": objectSchema("account requiresOpenaiAuth", {
    account: { type: ["object", "null"] },
    requiresOpenaiAuth: booleanSchema,
  }),
  "v2/ThreadStartParams.json": objectSchema("approvalPolicy sandbox never read-only", {
    cwd: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    approvalPolicy: { type: ["string", "null"], enum: ["never", null] },
    sandbox: { type: ["string", "null"], enum: ["read-only", null] },
    ephemeral: { type: ["boolean", "null"] },
    developerInstructions: { type: ["string", "null"] },
  }),
  "v2/ThreadStartResponse.json": objectSchema(
    "thread model modelProvider cwd approvalPolicy sandbox",
    {
      thread: { type: "object" },
      model: stringSchema,
      modelProvider: stringSchema,
      cwd: stringSchema,
      approvalPolicy: { type: "string", enum: ["never"] },
      sandbox: sandboxPolicySchema,
    },
  ),
  "v2/TurnStartParams.json": objectSchema(
    "threadId outputSchema approvalPolicy sandboxPolicy never readOnly",
    {
      threadId: stringSchema,
      cwd: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      approvalPolicy: { type: ["string", "null"], enum: ["never", null] },
      sandboxPolicy: sandboxPolicySchema,
      outputSchema: {},
    },
  ),
  "v2/TurnInterruptParams.json": objectSchema("threadId turnId", {
    threadId: stringSchema,
    turnId: stringSchema,
  }),
  "v2/TurnStartResponse.json": objectSchema("turn id status items", { turn: turnSchema }),
  "v2/ModelReroutedNotification.json": objectSchema("threadId turnId fromModel toModel reason", {
    threadId: stringSchema,
    turnId: stringSchema,
    fromModel: stringSchema,
    toModel: stringSchema,
    reason: stringSchema,
  }),
  "v2/TurnCompletedNotification.json": objectSchema(
    "threadId turn id status error items completed interrupted failed inProgress message codexErrorInfo additionalDetails",
    { threadId: stringSchema, turn: turnSchema },
  ),
  "v2/ThreadTokenUsageUpdatedNotification.json": objectSchema("threadId turnId tokenUsage", {
    threadId: stringSchema,
    turnId: stringSchema,
    tokenUsage: objectSchema("total", {
      total: objectSchema(
        "inputTokens cachedInputTokens cacheWriteInputTokens outputTokens reasoningOutputTokens",
        {
          inputTokens: numberSchema,
          cachedInputTokens: numberSchema,
          cacheWriteInputTokens: numberSchema,
          outputTokens: numberSchema,
          reasoningOutputTokens: numberSchema,
        },
      ),
    }),
  }),
  "codex_app_server_protocol.v2.schemas.json": {
    description:
      "contextWindowExceeded sessionBudgetExceeded usageLimitExceeded serverOverloaded cyberPolicy httpConnectionFailed responseStreamConnectionFailed internalServerError unauthorized badRequest other totalTokens inputTokens cachedInputTokens cacheWriteInputTokens outputTokens reasoningOutputTokens message codexErrorInfo additionalDetails model/rerouted highRiskCyberActivity fromModel toModel",
  },
};

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(
    process.env.MOCK_CLI_MODE === "invalid-version" ? "not-a-version\n" : "codex-cli 0.147.0\n",
  );
  process.exit(0);
}

if (
  args.length === 4 &&
  args[0] === "app-server" &&
  args[1] === "generate-ts" &&
  args[2] === "--out"
) {
  await generate(args[3]);
  process.exit(0);
}
if (
  args.length === 4 &&
  args[0] === "app-server" &&
  args[1] === "generate-json-schema" &&
  args[2] === "--out"
) {
  await generate(args[3], ".json");
  process.exit(0);
}
process.exit(1);

async function generate(output, extension = ".ts") {
  if (process.env.MOCK_CLI_MODE === "fail-generate") {
    process.stderr.write(`generation failed ${process.env.MOCK_CLI_STDERR_VALUE ?? ""}`);
    process.exit(7);
  }
  if (process.env.MOCK_CLI_MODE === "hang-generate") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  const sourceFiles = extension === ".ts" ? tsFiles : jsonFiles;
  for (const [relativePath, originalContent] of Object.entries(sourceFiles)) {
    if (
      relativePath === process.env.MOCK_CLI_MISSING ||
      (extension === ".json" &&
        `${relativePath.replace(/\.json$/, ".ts")}` === process.env.MOCK_CLI_MISSING)
    )
      continue;
    const shapeChangedContent =
      extension === ".json" &&
      process.env.MOCK_CLI_MODE === "incompatible-shape" &&
      relativePath === "v2/TurnStartParams.json"
        ? {
            ...originalContent,
            properties: { ...originalContent.properties, threadId: { type: "number" } },
          }
        : originalContent;
    const incompatibleContent =
      extension === ".json" &&
      process.env.MOCK_CLI_MODE === "incompatible-nesting" &&
      relativePath === "v2/TurnStartParams.json"
        ? {
            ...shapeChangedContent,
            properties: {
              ...shapeChangedContent.properties,
              threadId: undefined,
              wrapper: objectSchema("threadId", { threadId: stringSchema }),
            },
          }
        : shapeChangedContent;
    const serialized =
      extension === ".ts"
        ? JSON.stringify({ content: incompatibleContent })
        : JSON.stringify(incompatibleContent);
    const content = process.env.MOCK_CLI_MISSING_FRAGMENT
      ? serialized.replace(process.env.MOCK_CLI_MISSING_FRAGMENT, "")
      : serialized;
    const path = join(output, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${content}\n`);
  }
  const count = extension === ".ts" ? 617 : 269;
  for (let index = 0; index < count; index += 1) {
    const path = join(output, "generated", `Extra${String(index).padStart(3, "0")}${extension}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ index, variant: process.env.MOCK_CLI_EXTRA_VARIANT ?? "base" }) + "\n",
    );
  }
  const marker = process.env.MOCK_CLI_MARKER_FILE;
  if (marker) await writeFile(marker, `${dirname(output)}\n`);
}

function objectSchema(description, properties) {
  return { description, type: "object", properties };
}

function methodSchema(description, methods) {
  return {
    description,
    oneOf: methods.map((method) => ({
      type: "object",
      properties: { method: { type: "string", enum: [method] } },
    })),
  };
}
