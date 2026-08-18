import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--experimental")) process.exit(2);
if (process.env.MOCK_CLI_PID_FILE)
  await writeFile(process.env.MOCK_CLI_PID_FILE, `${process.pid}\n`);

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

const jsonFiles = {
  "ClientNotification.json": "initialized\n",
  "ClientRequest.json": "initialize account/read thread/start turn/start turn/interrupt\n",
  "ServerNotification.json":
    "item/completed turn/completed thread/tokenUsage/updated item/agentMessage/delta model/rerouted\n",
  "v2/AgentMessageDeltaNotification.json": "threadId turnId itemId delta\n",
  "v2/ItemCompletedNotification.json": "threadId turnId item completedAtMs\n",
  "v2/GetAccountParams.json": "refreshToken\n",
  "v2/GetAccountResponse.json": "account requiresOpenaiAuth\n",
  "v2/ThreadStartParams.json": "approvalPolicy sandbox never read-only\n",
  "v2/ThreadStartResponse.json": "thread model modelProvider cwd approvalPolicy sandbox\n",
  "v2/TurnStartParams.json": "threadId outputSchema approvalPolicy sandboxPolicy never readOnly\n",
  "v2/TurnInterruptParams.json": "threadId turnId\n",
  "v2/TurnStartResponse.json": "turn id status items\n",
  "v2/ModelReroutedNotification.json": "threadId turnId fromModel toModel reason\n",
  "v2/TurnCompletedNotification.json":
    "threadId turn id status error items completed interrupted failed inProgress message codexErrorInfo additionalDetails\n",
  "v2/ThreadTokenUsageUpdatedNotification.json": "threadId turnId tokenUsage\n",
  "codex_app_server_protocol.v2.schemas.json":
    "contextWindowExceeded sessionBudgetExceeded usageLimitExceeded serverOverloaded cyberPolicy httpConnectionFailed responseStreamConnectionFailed internalServerError unauthorized badRequest other totalTokens inputTokens cachedInputTokens cacheWriteInputTokens outputTokens reasoningOutputTokens message codexErrorInfo additionalDetails model/rerouted highRiskCyberActivity fromModel toModel\n",
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
    process.stderr.write(`generation failed ${process.env.MOCK_SECRET ?? ""}`);
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
    const content = process.env.MOCK_CLI_MISSING_TOKEN
      ? originalContent.replace(process.env.MOCK_CLI_MISSING_TOKEN, "")
      : originalContent;
    const path = join(output, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ content }) + "\n");
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
