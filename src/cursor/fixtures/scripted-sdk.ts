// Offline stand-in for `@cursor/sdk`. worker.test.ts bundles the real worker with
// this module aliased over the package, so the worker's SDK loop, IPC, and
// disposal run unmodified against a scripted agent. The worker process reads its
// script from argv[2]; every SDK interaction is appended to the script's log so
// the parent test can inspect it even after the worker is killed.
import { appendFileSync, readFileSync } from "node:fs";
import type { AgentOptions, Run, RunResult, SDKMessage } from "@cursor/sdk";
import { z } from "zod";

const ScriptedEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["assistant", "request", "task"]) }).strict(),
  z
    .object({
      type: z.literal("tool_call"),
      name: z.string(),
      status: z.enum(["running", "completed", "error"]),
    })
    .strict(),
]);

const ScriptedOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("finished"),
      result: z.string(),
      model: z.string(),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).strict(),
    })
    .strict(),
  z.object({ status: z.literal("error"), message: z.string() }).strict(),
  // The stream stays open until the worker calls Run.cancel().
  z.object({ status: z.literal("hang") }).strict(),
]);

const ScriptedTurnSchema = z
  .object({ events: z.array(ScriptedEventSchema).optional(), outcome: ScriptedOutcomeSchema })
  .strict();

export const ScriptSchema = z
  .object({
    logPath: z.string().min(1),
    turns: z.array(ScriptedTurnSchema),
    createError: z.string().optional(),
    sendError: z.string().optional(),
    disposeError: z.string().optional(),
  })
  .strict();

export const SdkLogEntrySchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create"),
      model: z.string().optional(),
      tools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      mcpServers: z.array(z.string()).optional(),
      settingSources: z.array(z.string()).optional(),
      enableAgentRetries: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal("send"), prompt: z.string() }).strict(),
  z.object({ op: z.literal("cancel") }).strict(),
  z.object({ op: z.literal("dispose") }).strict(),
]);

export type ScriptedEvent = z.input<typeof ScriptedEventSchema>;
export type ScriptedTurn = z.input<typeof ScriptedTurnSchema>;
export type Script = z.input<typeof ScriptSchema>;
export type SdkLogEntry = z.output<typeof SdkLogEntrySchema>;

const runId = "scripted-run";
const agentId = "scripted-agent";

// Loaded on first SDK call so the test can import the schemas without a worker argv.
let loadedScript: z.output<typeof ScriptSchema> | undefined;
function script(): z.output<typeof ScriptSchema> {
  if (loadedScript) return loadedScript;
  const path = process.argv[2];
  if (path === undefined) throw new Error("scripted SDK needs a script path in argv[2]");
  loadedScript = ScriptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return loadedScript;
}

function record(entry: z.input<typeof SdkLogEntrySchema>): void {
  appendFileSync(script().logPath, `${JSON.stringify(entry)}\n`);
}

export class JsonlLocalAgentStore {
  constructor(readonly directory: string) {}
}

type ScriptedRun = Pick<Run, "stream" | "wait" | "cancel">;
type ScriptedAgent = {
  readonly agentId: string;
  send(prompt: string): Promise<ScriptedRun>;
  [Symbol.asyncDispose](): Promise<void>;
};

export const Agent = {
  async create(options: AgentOptions): Promise<ScriptedAgent> {
    record({
      op: "create",
      model: options.model?.id,
      tools: options.tools,
      disallowedTools: options.disallowedTools,
      mcpServers: Object.keys(options.mcpServers ?? {}),
      settingSources: options.local?.settingSources,
      enableAgentRetries: options.local?.enableAgentRetries,
    });
    if (script().createError) throw new Error(script().createError);
    return createAgent();
  },
};

function createAgent(): ScriptedAgent {
  let turn = 0;
  return {
    agentId,
    async send(prompt) {
      record({ op: "send", prompt });
      if (script().sendError) throw new Error(script().sendError);
      const next = script().turns[turn++];
      if (!next) throw new Error("scripted SDK has no turn left");
      return createRun(next);
    },
    async [Symbol.asyncDispose]() {
      record({ op: "dispose" });
      if (script().disposeError) throw new Error(script().disposeError);
    },
  };
}

function createRun(turn: z.output<typeof ScriptedTurnSchema>): ScriptedRun {
  let cancelled = false;
  let release = (): void => undefined;
  const cancelSignal = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = turn.outcome;
  return {
    async *stream() {
      for (const event of turn.events ?? []) yield toMessage(event);
      if (outcome.status === "hang") await cancelSignal;
    },
    async wait(): Promise<RunResult> {
      if (outcome.status === "hang") {
        await cancelSignal;
        return { id: runId, status: "cancelled" };
      }
      if (cancelled) return { id: runId, status: "cancelled" };
      if (outcome.status === "error")
        return { id: runId, status: "error", error: { message: outcome.message } };
      return {
        id: runId,
        status: "finished",
        result: outcome.result,
        model: { id: outcome.model },
        usage: {
          ...outcome.usage,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
        },
      };
    },
    async cancel() {
      record({ op: "cancel" });
      cancelled = true;
      release();
    },
  };
}

function toMessage(event: z.output<typeof ScriptedEventSchema>): SDKMessage {
  const base = { agent_id: agentId, run_id: runId };
  switch (event.type) {
    case "tool_call":
      return {
        ...base,
        type: "tool_call",
        call_id: "call",
        name: event.name,
        status: event.status,
      };
    case "assistant":
      return {
        ...base,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      };
    case "request":
      return { ...base, type: "request", request_id: "request" };
    case "task":
      return { ...base, type: "task" };
  }
}
