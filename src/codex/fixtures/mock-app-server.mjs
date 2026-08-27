import { createInterface } from "node:readline";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { execa } from "execa";

const mode = process.env.MOCK_APP_SERVER_MODE ?? "basic";
if (
  [
    "marker",
    "authoritative",
    "item-correlation",
    "completed-no-delta",
    "completion-after-cancel-usage",
    "file-change",
    "marker-retry",
    "marker-three-invalid",
    "output-schema",
    "output-schema-default",
    "output-schema-retry",
    "output-schema-three-invalid",
    "reasoning-no-variant",
    "reasoning-supported",
    "reasoning-supported-no-cursor",
    "reasoning-paginated",
    "reasoning-unsupported",
    "reasoning-empty",
    "reasoning-model-list-error",
    "reasoning-model-list-malformed",
    "reasoning-model-list-timeout",
    "auth-null",
    "auth-apikey",
    "policy-approval",
    "policy-sandbox",
    "policy-cwd",
    "canonical-cwd",
    "turn-status",
    "turn-failed",
    "turn-failed-empty-info",
    "usage-omitted",
    "model-rerouted",
    "turn-start-mutates",
    "turn-failed-mutates",
    "cancel-active-mutates",
    "cancel-active-hung",
    "cancel-active-close-rejects",
    "timeout-thread",
    "cancel-before",
    "cancel-active",
    "timeout-active",
    "timeout-active-mutates-restores",
    "repository-unchanged",
    "repository-mutates",
    "teardown-mutates",
    "spike-marker",
    "spike-three-invalid",
    "spike-cancel-active",
  ].includes(mode) &&
  (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)
) {
  process.stderr.write("unexpected api key environment\n");
  process.exit(2);
}
process.stderr.write(`${process.env.MOCK_APP_SERVER_SECRET ?? ""}${"s".repeat(256)}`);
if (["hung", "cancel-active-hung", "ignores-sigterm", "stdout-eof-hung"].includes(mode))
  setInterval(() => {}, 1_000);
if (mode === "ignores-sigterm") process.on("SIGTERM", () => {});
if (mode === "cancel-active-close-rejects") {
  const descendant = execa(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: true,
    reject: false,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  descendant.unref();
  if (descendant.pid === undefined || process.env.MOCK_CLI_PID_FILE === undefined) process.exit(2);
  writeFileSync(process.env.MOCK_CLI_PID_FILE, `${descendant.pid}\n`);
}

const requests = [];
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let markerStep = 0;
let attempt = 0;
const expectedModel = process.env.MOCK_APP_SERVER_MODEL;
const expectedSystem = process.env.MOCK_APP_SERVER_SYSTEM;
const expectedUser = process.env.MOCK_APP_SERVER_USER;
const spikeReport = {
  summary: "spike summary",
  findings: [
    {
      severity: "error",
      file: "src.ts",
      line: 1,
      evidence: null,
      title: "In-scope finding",
      body: "A useful finding.",
      confidence: "high",
    },
    {
      severity: "warning",
      file: "outside.ts",
      line: 1,
      evidence: null,
      title: "Outside finding",
      body: "Should be filtered.",
      confidence: "high",
    },
    {
      severity: "info",
      file: "src.ts",
      line: 1,
      evidence: null,
      title: "Low confidence",
      body: "Should be filtered.",
      confidence: "low",
    },
  ],
};
const markerModes = [
  "marker",
  "authoritative",
  "item-correlation",
  "completed-no-delta",
  "completion-after-cancel-usage",
  "file-change",
  "marker-retry",
  "marker-three-invalid",
  "output-schema",
  "output-schema-default",
  "output-schema-retry",
  "output-schema-three-invalid",
  "reasoning-no-variant",
  "reasoning-supported",
  "reasoning-supported-no-cursor",
  "reasoning-paginated",
  "reasoning-unsupported",
  "reasoning-empty",
  "reasoning-model-list-error",
  "reasoning-model-list-malformed",
  "reasoning-model-list-timeout",
  "auth-null",
  "auth-apikey",
  "policy-approval",
  "policy-sandbox",
  "policy-cwd",
  "canonical-cwd",
  "turn-status",
  "turn-failed",
  "turn-failed-empty-info",
  "usage-omitted",
  "model-rerouted",
  "turn-start-mutates",
  "turn-failed-mutates",
  "cancel-active-mutates",
  "cancel-active-hung",
  "cancel-active-close-rejects",
  "timeout-thread",
  "cancel-before",
  "cancel-active",
  "timeout-active",
  "timeout-active-mutates-restores",
  "repository-unchanged",
  "repository-mutates",
  "teardown-mutates",
  "spike-marker",
  "spike-three-invalid",
  "spike-cancel-active",
].includes(mode);
const outputSchemaModes = markerModes;
const expectedReasoningVariant = process.env.MOCK_APP_SERVER_REASONING_VARIANT;
const modelListVariants = process.env.MOCK_APP_SERVER_MODEL_LIST_VARIANTS;
const retryModes = [
  "marker-retry",
  "marker-three-invalid",
  "output-schema-retry",
  "output-schema-three-invalid",
  "spike-three-invalid",
].includes(mode);
const reasoningModes = [
  "reasoning-no-variant",
  "reasoning-supported",
  "reasoning-supported-no-cursor",
  "reasoning-paginated",
  "reasoning-unsupported",
  "reasoning-empty",
  "reasoning-model-list-error",
  "reasoning-model-list-malformed",
  "reasoning-model-list-timeout",
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function markerError(message) {
  if (isNumber(message.id)) {
    send({
      id: message.id,
      error: { code: -32602, message: "invalid marker protocol", data: null },
    });
  }
}

function isRecord(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isText(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value) {
  return Number.isFinite(value);
}

function isOutputSchema(value) {
  if (
    !isRecord(value) ||
    value.type !== "object" ||
    value.additionalProperties !== false ||
    !Array.isArray(value.required) ||
    !value.required.includes("summary") ||
    !value.required.includes("findings")
  )
    return false;
  const properties = value.properties;
  if (
    !isRecord(properties) ||
    properties.summary?.type !== "string" ||
    !isRecord(properties.findings) ||
    properties.findings.type !== "array"
  )
    return false;
  const item = properties.findings.items;
  if (
    !isRecord(item) ||
    item.type !== "object" ||
    item.additionalProperties !== false ||
    !Array.isArray(item.required)
  )
    return false;
  return (
    ["severity", "confidence", "file", "line", "evidence", "title", "body"].every((name) =>
      item.required.includes(name),
    ) &&
    isRecord(item.properties) &&
    isRecord(item.properties.evidence) &&
    Array.isArray(item.properties.evidence.type) &&
    item.properties.evidence.type.includes("string") &&
    item.properties.evidence.type.includes("null")
  );
}

function handleMarker(message) {
  const params = message.params;
  if (markerStep === 0 && message.method === "initialize" && isNumber(message.id)) {
    const clientInfo = isRecord(params) ? params.clientInfo : undefined;
    if (
      !isRecord(clientInfo) ||
      !isText(clientInfo.name) ||
      !isText(clientInfo.title) ||
      !isText(clientInfo.version) ||
      params.capabilities !== null ||
      Object.hasOwn(params, "experimental")
    )
      return markerError(message);
    markerStep = 1;
    send({
      id: message.id,
      result: {
        userAgent: "codex-cli/0.147.0",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (markerStep === 1 && message.method === "initialized" && message.id === undefined) {
    markerStep = 2;
    return;
  }
  if (markerStep === 2 && message.method === "account/read" && isNumber(message.id)) {
    if (!isRecord(params) || params.refreshToken !== false) return markerError(message);
    markerStep = 3;
    const account =
      mode === "auth-null"
        ? null
        : { type: mode === "auth-apikey" ? "apiKey" : "chatgpt", email: null, planType: "plus" };
    send({ id: message.id, result: { account, requiresOpenaiAuth: true } });
    return;
  }
  if (
    reasoningModes.includes(mode) &&
    (markerStep === 3 || (mode === "reasoning-paginated" && markerStep === 3.25)) &&
    message.method === "model/list" &&
    isNumber(message.id)
  ) {
    if (!isRecord(params) || params.includeHidden !== true || params.limit !== 100)
      return markerError(message);
    if (mode === "reasoning-paginated" && markerStep === 3) {
      if ("cursor" in params) return markerError(message);
      markerStep = 3.25;
      send({
        id: message.id,
        result: {
          data: [
            {
              id: "another-model",
              model: "another-model",
              supportedReasoningEfforts: [],
            },
          ],
          nextCursor: "page-2",
        },
      });
      return;
    }
    if (mode === "reasoning-paginated" && params.cursor !== "page-2")
      return markerError(message);
    markerStep = 3.5;
    if (mode === "reasoning-model-list-timeout") return;
    if (mode === "reasoning-model-list-error") {
      send({
        id: message.id,
        error: { code: -32602, message: "model list unavailable", data: null },
      });
      return;
    }
    if (mode === "reasoning-model-list-malformed") {
      send({ id: message.id, result: { data: "not-an-array", nextCursor: null } });
      return;
    }
    const variants =
      modelListVariants === undefined || modelListVariants === ""
        ? []
        : modelListVariants.split(",");
    if (mode === "reasoning-supported-no-cursor") {
      send({
        id: message.id,
        result: {
          data: [
            {
              id: expectedModel,
              model: expectedModel,
              supportedReasoningEfforts: variants.map((reasoningEffort) => ({ reasoningEffort })),
            },
          ],
        },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [
          {
            id: expectedModel,
            model: expectedModel,
            supportedReasoningEfforts: variants.map((reasoningEffort) => ({ reasoningEffort })),
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }
  if (
    (markerStep === 3 || markerStep === 3.5) &&
    message.method === "thread/start" &&
    isNumber(message.id)
  ) {
    if (["auth-null", "auth-apikey"].includes(mode)) return markerError(message);
    const systemPromptOk =
      isRecord(params) &&
      isText(params.developerInstructions) &&
      (["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode)
        ? params.developerInstructions.includes("DiffOwl")
        : expectedSystem
          ? params.developerInstructions.includes(expectedSystem)
          : params.developerInstructions.includes("DiffOwl") &&
            params.developerInstructions.includes("Semantics and constraints:") &&
            params.developerInstructions.includes("Review rules:") &&
            params.developerInstructions.includes("JSON-only"));
    const developerInstructionsOk = outputSchemaModes
      ? isRecord(params) &&
        isText(params.developerInstructions) &&
        systemPromptOk &&
        !params.developerInstructions.includes("FINAL_REVIEW_JSON")
      : ["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode)
        ? systemPromptOk
        : isRecord(params) && params.developerInstructions === expectedSystem;
    if (
      !isRecord(params) ||
      (!["spike-marker", "spike-three-invalid", "spike-cancel-active", "canonical-cwd"].includes(
        mode,
      ) &&
        params.cwd !== process.cwd()) ||
      (mode === "canonical-cwd" &&
        (!isText(params.cwd) || realpathSync(params.cwd) !== process.cwd())) ||
      (["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode) &&
        !isText(params.cwd)) ||
      params.model !== expectedModel ||
      params.approvalPolicy !== "never" ||
      params.sandbox !== "read-only" ||
      params.ephemeral !== true ||
      !developerInstructionsOk
    ) {
      if (["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode)) {
        send({
          id: message.id,
          error: {
            code: -32602,
            message: `invalid marker protocol at ${markerStep}:${message.method}`,
            data: null,
          },
        });
      } else markerError(message);
      return;
    }
    markerStep = 4;
    const threadResponse = {
      id: message.id,
      result: {
        thread: { id: "thread-1", title: null },
        model: expectedModel,
        modelProvider: "openai",
        cwd:
          mode === "policy-cwd"
            ? `${process.cwd()}-other`
            : mode === "canonical-cwd"
              ? realpathSync(params.cwd)
              : ["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode)
                ? params.cwd
                : process.cwd(),
        approvalPolicy: mode === "policy-approval" ? "on-request" : "never",
        sandbox: { type: "readOnly", networkAccess: mode === "policy-sandbox" },
        futureField: "ignored",
      },
    };
    if (mode === "timeout-thread")
      setTimeout(() => send(threadResponse), process.platform === "win32" ? 5_500 : 500);
    else send(threadResponse);
    return;
  }
  if (
    [
      "cancel-active",
      "timeout-active",
      "timeout-active-mutates-restores",
      "cancel-active-mutates",
      "cancel-active-hung",
      "cancel-active-close-rejects",
      "spike-cancel-active",
    ].includes(mode) &&
    markerStep === 5 &&
    message.method === "turn/interrupt" &&
    isNumber(message.id)
  ) {
    if (!isRecord(params) || params.threadId !== "thread-1" || !isText(params.turnId))
      return markerError(message);
    const sendInterruption = () => {
      send({ id: message.id, result: {} });
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: params.turnId, status: "interrupted", items: [], error: null },
        },
      });
    };
    const interruptionDelayMs = Number(process.env.MOCK_INTERRUPT_DELAY_MS ?? 0);
    if (interruptionDelayMs > 0) setTimeout(sendInterruption, interruptionDelayMs);
    else sendInterruption();
    return;
  }
  if (
    (markerStep === 4 || (markerStep === 5 && retryModes)) &&
    message.method === "turn/start" &&
    isNumber(message.id)
  ) {
    if (mode === "turn-start-mutates") {
      writeFileSync("codex-mutated.txt", "provider mutation\n");
      markerError(message);
      return;
    }
    const item = isRecord(params) && Array.isArray(params.input) ? params.input[0] : undefined;
    const policy = isRecord(params) ? params.sandboxPolicy : undefined;
    attempt++;
    const retryPromptOk =
      attempt === 1
        ? isRecord(item) &&
          (["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode)
            ? isText(item.text) && item.text.length > 0
            : expectedUser === undefined
              ? isText(item.text) && item.text.length > 0
              : item.text === expectedUser)
        : isRecord(item) &&
          (outputSchemaModes
            ? isText(item.text) &&
              !item.text.includes("FINAL_REVIEW_JSON") &&
              item.text.includes("replacement JSON object")
            : isText(item.text) && item.text.includes("FINAL_REVIEW_JSON"));
    const outputSchemaOk = outputSchemaModes
      ? isRecord(params) && isOutputSchema(params.outputSchema)
      : isRecord(params) && !Object.hasOwn(params, "outputSchema");
    const reasoningVariantOk =
      expectedReasoningVariant === undefined
        ? isRecord(params) && !Object.hasOwn(params, "effort")
        : isRecord(params) && params.effort === expectedReasoningVariant;
    if (
      !isRecord(params) ||
      params.threadId !== "thread-1" ||
      (!["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode) &&
        params.cwd !== process.cwd()) ||
      (["spike-marker", "spike-three-invalid", "spike-cancel-active"].includes(mode) &&
        !isText(params.cwd)) ||
      params.model !== expectedModel ||
      params.approvalPolicy !== "never" ||
      !isRecord(policy) ||
      policy.type !== "readOnly" ||
      policy.networkAccess !== false ||
      !isRecord(item) ||
      item.type !== "text" ||
      !retryPromptOk ||
      !Array.isArray(item.text_elements) ||
      item.text_elements.length !== 0 ||
      !outputSchemaOk ||
      !reasoningVariantOk
    )
      return markerError(message);
    markerStep = 5;
    const turnId = `turn-${attempt}`;
    send({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          status: mode === "turn-status" ? "completed" : "inProgress",
          items: [],
        },
      },
    });
    if (
      [
        "cancel-active",
        "timeout-active",
        "timeout-active-mutates-restores",
        "cancel-active-mutates",
        "cancel-active-hung",
        "cancel-active-close-rejects",
        "spike-cancel-active",
      ].includes(mode)
    ) {
      if (process.env.MOCK_ACTIVE_TURN_FILE)
        writeFileSync(process.env.MOCK_ACTIVE_TURN_FILE, turnId);
      if (["cancel-active-mutates", "timeout-active-mutates-restores"].includes(mode))
        writeFileSync("codex-mutated.txt", "provider mutation\n");
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId, itemId: `item-${attempt}`, delta: "held" },
      });
      return;
    }
    if (mode === "repository-mutates") writeFileSync("codex-mutated.txt", "provider mutation\n");
    if (["turn-failed", "turn-failed-empty-info", "turn-failed-mutates"].includes(mode)) {
      if (mode === "turn-failed-mutates") writeFileSync("codex-mutated.txt", "provider mutation\n");
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: turnId,
            status: "failed",
            items: [],
            error: {
              message: mode === "turn-failed-empty-info" ? "" : "provider failed",
              codexErrorInfo: mode === "turn-failed-empty-info" ? "other" : null,
              additionalDetails: mode === "turn-failed-empty-info" ? null : "provider detail",
              futureField: "ignored",
            },
          },
        },
      });
      return;
    }
    const invalid =
      (mode === "marker-retry" && attempt === 1) ||
      ["marker-three-invalid", "spike-three-invalid", "output-schema-three-invalid"].includes(
        mode,
      ) ||
      (mode === "output-schema-retry" && attempt === 1);
    const finalText = invalid
      ? JSON.stringify({ summary: "invalid", findings: "not-an-array" })
      : mode === "spike-marker"
        ? JSON.stringify(spikeReport)
        : mode === "authoritative"
          ? JSON.stringify({ summary: "authoritative summary", findings: [] })
          : JSON.stringify({ summary: "schema summary", findings: [] });
    const agentMessage = {
      type: "agentMessage",
      id: `item-${attempt}`,
      text: finalText,
      phase: null,
      memoryCitation: null,
    };
    if (mode === "file-change") {
      send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId,
          item: { type: "fileChange", id: "file-1", changes: [] },
          completedAtMs: 1,
        },
      });
      return;
    }
    if (mode === "authoritative") {
      send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId,
          item: { type: "reasoning", id: "reason-1" },
          completedAtMs: 1,
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId,
          item: { type: "commandExecution", id: "command-1" },
          completedAtMs: 1,
        },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId, itemId: "item-1", delta: "wrong partial" },
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId,
          item: { type: "agentMessage", id: "item-2", text: "wrong completed" },
          completedAtMs: 1,
        },
      });
    } else if (mode === "item-correlation") {
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId, itemId: "item-1", delta: "wrong partial" },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId, itemId: "item-2", delta: "unrelated partial" },
      });
      send({
        method: "item/completed",
        params: { threadId: "thread-1", turnId, item: agentMessage, completedAtMs: 1 },
      });
    } else if (["completed-no-delta", "completion-after-cancel-usage"].includes(mode)) {
      send({
        method: "item/completed",
        params: { threadId: "thread-1", turnId, item: agentMessage, completedAtMs: 1 },
      });
    } else if (outputSchemaModes) {
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId, itemId: `item-${attempt}`, delta: "json delta" },
      });
      send({
        method: "item/completed",
        params: { threadId: "thread-1", turnId, item: agentMessage, completedAtMs: 1 },
      });
    } else {
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId, itemId: `item-${attempt}`, delta: "marker delta" },
      });
      send({
        method: "item/completed",
        params: { threadId: "thread-1", turnId, item: agentMessage, completedAtMs: 1 },
      });
    }
    if (mode === "model-rerouted") {
      send({
        method: "model/rerouted",
        params: {
          threadId: "thread-1",
          turnId,
          fromModel: expectedModel,
          toModel: "gpt-5-mini",
          reason: "highRiskCyberActivity",
        },
      });
    }
    const usage = {
      totalTokens: 321,
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 2,
      outputTokens: 200,
      reasoningOutputTokens: 19,
    };
    if (mode === "usage-omitted") delete usage.cacheWriteInputTokens;
    const sendUsage = () => {
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId,
          tokenUsage: { total: usage, last: usage, modelContextWindow: null },
        },
      });
    };
    const sendCompletion = () => {
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: turnId,
            status: "completed",
            items: [
              "item-correlation",
              "completed-no-delta",
              "completion-after-cancel-usage",
            ].includes(mode)
              ? []
              : [agentMessage],
            error: null,
          },
        },
      });
    };
    if (mode === "completion-after-cancel-usage") {
      setTimeout(() => {
        sendUsage();
        setTimeout(sendCompletion, 40);
      }, 20);
      return;
    }
    sendUsage();
    sendCompletion();
    return;
  }
  markerError(message);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (markerModes) {
    handleMarker(message);
    return;
  }
  if (["malformed-json", "malformed-envelope"].includes(mode) && isNumber(message.id)) {
    if (mode === "malformed-json") process.stdout.write("{not-json}\n");
    else send({ id: message.id });
    return;
  }
  if (mode === "premature-eof" && isNumber(message.id)) {
    setImmediate(() => process.exit(0));
    return;
  }
  if (mode === "stdout-eof-hung" && isNumber(message.id)) {
    process.stdout.end();
    return;
  }
  if (mode === "server-request" && isNumber(message.id)) {
    send({ id: "server-request-1", method: "server.ask", params: { question: "?" } });
    return;
  }
  if (["immediate", "ignores-sigterm"].includes(mode) && isNumber(message.id)) {
    send({ id: message.id, result: { request: message.method } });
    return;
  }
  if (!["basic", "rpc-error"].includes(mode) || !isNumber(message.id)) return;
  requests.push(message);
  if (requests.length !== 2) return;
  if (mode === "rpc-error") {
    setTimeout(
      () =>
        send({
          id: requests[0].id,
          error: { code: 42, message: "bad request", data: { field: "x" } },
        }),
      10,
    );
    setTimeout(() => send({ id: requests[1].id, result: { request: "good" } }), 20);
    return;
  }
  setTimeout(() => send({ id: requests[1].id, result: { request: "second" } }), 10);
  setTimeout(() => {
    send({ id: requests[0].id, result: { request: "first" } });
    send({ method: "server.ready", params: { requests: 2 } });
  }, 20);
});

input.on("close", () => {
  if (mode === "timeout-active-mutates-restores") rmSync("codex-mutated.txt", { force: true });
  if (mode === "teardown-mutates")
    writeFileSync("codex-mutated-on-close.txt", "teardown mutation\n");
  if (
    [
      "basic",
      "immediate",
      "rpc-error",
      "marker",
      "authoritative",
      "item-correlation",
      "completed-no-delta",
      "completion-after-cancel-usage",
      "file-change",
      "marker-retry",
      "marker-three-invalid",
      "output-schema",
      "output-schema-default",
      "output-schema-retry",
      "output-schema-three-invalid",
      "reasoning-no-variant",
      "reasoning-supported",
      "reasoning-supported-no-cursor",
      "reasoning-paginated",
      "reasoning-unsupported",
      "reasoning-empty",
      "reasoning-model-list-error",
      "reasoning-model-list-malformed",
      "auth-null",
      "auth-apikey",
      "policy-approval",
      "policy-sandbox",
      "policy-cwd",
      "canonical-cwd",
      "turn-status",
      "turn-failed",
      "turn-failed-empty-info",
      "usage-omitted",
      "model-rerouted",
      "turn-start-mutates",
      "turn-failed-mutates",
      "timeout-thread",
      "cancel-before",
      "cancel-active",
      "cancel-active-mutates",
      "cancel-active-close-rejects",
      "timeout-active",
      "timeout-active-mutates-restores",
      "repository-unchanged",
      "repository-mutates",
      "teardown-mutates",
      "spike-marker",
      "spike-three-invalid",
      "spike-cancel-active",
    ].includes(mode)
  )
    setImmediate(() => process.exit(0));
});
