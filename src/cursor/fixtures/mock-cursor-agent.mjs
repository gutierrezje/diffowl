import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const expectedModel = process.env.MOCK_CURSOR_MODEL ?? "gpt-5.6-luna";
const expectedReasoning = process.env.MOCK_CURSOR_REASONING ?? "high";
const expectedUser = process.env.MOCK_CURSOR_USER;
const requiredBoundary = process.env.MOCK_CURSOR_REQUIRED_BOUNDARY;
const mockMode = process.env.MOCK_CURSOR_MODE ?? "success";
const keepAlive = ["sigkill", "sigterm-code"].includes(mockMode)
  ? setInterval(() => {}, 1_000)
  : undefined;
let initialized = false;
let authenticated = false;
let sessionStarted = false;
let selectedModel = "default";
let selectedReasoning = "low";
let selectedMode = "agent";
let promptCount = 0;
let activePromptId;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function fail(message, detail) {
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32602, message: detail } });
  }
}

function completePrompt(promptId, text = 'FINAL_REVIEW_JSON\n{"summary":"cursor summary","findings":[]}') {
  const chunks = mockMode === "multi-chunk"
    ? [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))]
    : [text];
  for (const chunk of chunks) {
    send({
      method: "session/update",
      params: {
        sessionId: "cursor-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      },
    });
  }
  send({ id: promptId, result: { stopReason: "end_turn" } });
}

function configOptions() {
  const options = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: selectedMode,
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: selectedModel,
      options: [
        { value: "default", name: "Auto" },
        { value: expectedModel, name: "Test model" },
      ],
    },
  ];
  if (mockMode !== "no-reasoning") {
    options.push({
      id: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: selectedReasoning,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    });
  }
  return options;
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  if (message.method === "initialize" && mockMode === "malformed-json") {
    process.stdout.write("{malformed-json\n");
    return;
  }
  if (message.method === "initialize" && mockMode === "malformed-envelope") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "1.0", id: message.id, result: {} })}\n`);
    return;
  }
  if (message.method === "initialize" && mockMode === "unknown-response-id") {
    send({ id: 999, result: {} });
    return;
  }
  if (message.method === "initialize" && mockMode === "premature-eof") {
    process.exit(0);
  }
  if (message.method === "initialize" && mockMode === "hang-initialize") return;
  if (!initialized && message.method === "initialize") {
    if (
      params.protocolVersion !== 1 ||
      params.clientCapabilities?.fs?.readTextFile !== false ||
      params.clientCapabilities?.fs?.writeTextFile !== false ||
      params.clientCapabilities?.terminal !== false
    ) {
      return fail(message, "unsafe client capabilities");
    }
    if (mockMode === "mutate-initialize" && process.env.MOCK_CURSOR_MUTATION_PATH) {
      writeFileSync(process.env.MOCK_CURSOR_MUTATION_PATH, "mutated during initialize\n");
    }
    initialized = true;
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
      },
    });
    return;
  }
  if (initialized && !authenticated && message.method === "authenticate" && params.methodId === "cursor_login") {
    if (mockMode === "hang-auth") return;
    authenticated = true;
    send({ id: message.id, result: {} });
    return;
  }
  if (authenticated && !sessionStarted && message.method === "session/new") {
    sessionStarted = true;
    send({
      id: message.id,
      result: {
        sessionId: "cursor-session-1",
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
            { id: "ask", name: "Ask" },
          ],
        },
        configOptions: configOptions(),
      },
    });
    return;
  }
  if (authenticated && !sessionStarted && message.method === "cursor/list_available_models") {
    send({
      id: message.id,
      result: {
        models: [
          { value: "default", name: "Auto", configOptions: [] },
          { value: expectedModel, name: "Test model", configOptions: [] },
        ],
      },
    });
    return;
  }
  if (
    sessionStarted &&
    message.method === "session/set_config_option" &&
    params.configId === "model" &&
    params.value === expectedModel
  ) {
    selectedModel = expectedModel;
    send({ id: message.id, result: { configOptions: configOptions() } });
    return;
  }
  if (
    sessionStarted &&
    mockMode !== "no-reasoning" &&
    message.method === "session/set_config_option" &&
    params.configId === "reasoning" &&
    params.value === expectedReasoning
  ) {
    selectedReasoning = expectedReasoning;
    send({ id: message.id, result: { configOptions: configOptions() } });
    return;
  }
  if (
    sessionStarted &&
    message.method === "session/set_mode" &&
    params.modeId === "ask"
  ) {
    selectedMode = "ask";
    send({ id: message.id, result: {} });
    return;
  }
  if (sessionStarted && selectedMode === "ask" && message.method === "session/prompt") {
    const text = String(params.prompt?.[0]?.text ?? "");
    if (
      text === "" ||
      (expectedUser && !text.includes(expectedUser)) ||
      (requiredBoundary && !text.includes(requiredBoundary))
    ) {
      return fail(message, "unexpected prompt");
    }
    promptCount += 1;
    activePromptId = message.id;
    if (process.env.MOCK_CURSOR_PROMPT_MARKER) {
      writeFileSync(process.env.MOCK_CURSOR_PROMPT_MARKER, "ready\n");
    }
    if (mockMode === "hang") return;
    if (mockMode === "permission" || mockMode === "read-permission") {
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: "cursor-session-1",
          toolCall: {
            toolCallId: "tool-1",
            title: mockMode === "read-permission" ? "Read src/app.ts" : "Run command",
            kind: mockMode === "read-permission" ? "read" : "execute",
          },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
        },
      });
      return;
    }
    if (mockMode === "mutate" && process.env.MOCK_CURSOR_MUTATION_PATH) {
      writeFileSync(process.env.MOCK_CURSOR_MUTATION_PATH, "mutated\n");
    }
    const reviewText = mockMode === "provider-limit"
      ? "ActionRequiredError: Increase limits for faster responses. You're out of usage."
      : mockMode === "quota-phrase-review"
        ? 'FINAL_REVIEW_JSON\n{"summary":"Upgrade your plan for rate limits in the application.","findings":[]}'
        : mockMode === "quota-phrase-unmarked-then-valid" && promptCount === 1
          ? "Upgrade your plan for rate limits in the application."
        : mockMode === "invalid-then-valid" && promptCount === 1
          ? 'FINAL_REVIEW_JSON\n{"summary":"missing findings"}'
          : 'FINAL_REVIEW_JSON\n{"summary":"cursor summary","findings":[]}';
    completePrompt(message.id, reviewText);
    return;
  }
  if (message.method === "session/cancel") {
    if (process.env.MOCK_CURSOR_CANCEL_MARKER) {
      writeFileSync(process.env.MOCK_CURSOR_CANCEL_MARKER, "cancelled\n");
    }
    return;
  }
  if (message.id === "permission-1" && message.result) {
    if (mockMode === "read-permission") {
      if (message.result.outcome?.optionId !== "allow") process.exit(2);
      completePrompt(activePromptId);
    }
    return;
  }
  fail(message, `unexpected request: ${message.method}`);
});

input.on("close", () => {
  if (!["sigkill", "sigterm-code"].includes(mockMode)) process.exit(0);
});

process.on("SIGTERM", () => {
  if (mockMode === "sigterm-code") {
    clearInterval(keepAlive);
    process.exit(143);
  }
});
