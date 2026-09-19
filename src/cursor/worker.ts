import { Agent, JsonlLocalAgentStore, type Run, type SDKAgent } from "@cursor/sdk";
import { getEachMessage, sendMessage } from "execa";
import { decideReviewAttempt, inspectReviewText } from "../review/document.js";
import { aggregateReviewUsage, type ReviewUsage } from "../review/usage.js";
import { CursorReviewError, cursorFailure } from "./errors.js";
import {
  CURSOR_READ_ONLY_TOOLS,
  CursorCancelSchema,
  CursorStartSchema,
  type CursorMessage,
} from "./protocol.js";

async function main(): Promise<void> {
  const messages = getEachMessage();
  const first = await messages.next();
  const request = CursorStartSchema.parse(first.value);
  let agent: SDKAgent | undefined;
  let activeRun: Run | undefined;
  let cancelled = false;
  let cancelFailure: Error | undefined;
  const cancel = async (): Promise<void> => {
    cancelled = true;
    if (activeRun) await activeRun.cancel();
  };
  // Receive cancellation even while create(), send(), or stream() is awaiting the SDK.
  void (async () => {
    for await (const value of messages) {
      CursorCancelSchema.parse(value);
      await cancel();
    }
    await cancel();
  })().catch((error: Error) => {
    cancelFailure = error;
    cancelled = true;
  });

  let result: Extract<CursorMessage, { kind: "result" }> | undefined;
  let failure: Error | undefined;
  const usages: ReviewUsage[] = [];
  let effectiveModel: string | null = null;
  try {
    agent = await Agent.create({
      model: { id: request.model },
      tools: CURSOR_READ_ONLY_TOOLS,
      disallowedTools: ["shell", "mcp", "task"],
      local: {
        cwd: request.directory,
        store: new JsonlLocalAgentStore(request.storeDirectory),
        settingSources: [],
        enableAgentRetries: false,
      },
      mcpServers: {},
    });
    await sendMessage({ kind: "session", id: agent.agentId });
    let prompt = request.prompt;
    for (let attempt = 1; ; attempt++) {
      if (cancelled) throw cancelFailure ?? new Error("Cursor review cancelled.");
      activeRun = await agent.send(prompt);
      if (cancelled) await activeRun.cancel();
      for await (const event of activeRun.stream()) {
        switch (event.type) {
          case "tool_call":
            if (!CURSOR_READ_ONLY_TOOLS.includes(event.name)) {
              throw new CursorReviewError(
                "policy",
                `Cursor attempted disallowed tool ${event.name}.`,
              );
            }
            await sendMessage({ kind: "tool", name: event.name, status: event.status });
            break;
          case "request":
          case "task":
            throw new CursorReviewError(
              "policy",
              `Cursor attempted unsupported ${event.type} interaction.`,
            );
          case "thinking":
          case "assistant":
          case "usage":
          case "system":
          case "status":
          case "user":
            await sendMessage({ kind: "activity" });
            break;
          default: {
            const exhaustive: never = event;
            throw new CursorReviewError("protocol", `Unknown SDK event: ${String(exhaustive)}`);
          }
        }
      }
      const turn = await activeRun.wait();
      activeRun = undefined;
      if (cancelled) throw cancelFailure ?? new Error("Cursor review cancelled.");
      if (turn.status !== "finished") {
        const failure = cursorFailure(turn.error ?? new Error(`Cursor turn ${turn.status}.`));
        throw new CursorReviewError(failure.category, failure.message);
      }
      if (turn.model?.id) effectiveModel = turn.model.id;
      if (turn.usage)
        usages.push({
          tokens: {
            input: turn.usage.inputTokens,
            output: turn.usage.outputTokens,
            reasoning: turn.usage.reasoningTokens ?? 0,
            cache: { read: turn.usage.cacheReadTokens, write: turn.usage.cacheWriteTokens },
          },
          cost: null,
        });
      const text = turn.result ?? "";
      const inspection = inspectReviewText(text);
      const decision = decideReviewAttempt({
        closed: inspection.kind === "open" ? inspection.ifFinished : inspection,
        attempt,
      });
      await sendMessage({
        kind: "validation",
        outcome:
          decision.kind === "accept" ? "accepted" : decision.kind === "retry" ? "retry" : "failed",
        attempt,
      });
      if (decision.kind === "fail")
        throw new CursorReviewError("validation", decision.error.message);
      if (decision.kind === "retry") {
        prompt = decision.userMessage;
        continue;
      }
      result = {
        kind: "result",
        text,
        sessionId: agent.agentId,
        effectiveModel,
        usage: aggregateReviewUsage(usages) ?? null,
      };
      break;
    }
  } catch (error) {
    const detail = cursorFailure(error);
    failure = new CursorReviewError(detail.category, detail.message, { cause: error });
  } finally {
    try {
      try {
        if (activeRun) await activeRun.cancel();
      } finally {
        if (agent) await agent[Symbol.asyncDispose]();
      }
    } catch (error) {
      failure ??= new CursorReviewError(
        "teardown",
        `Cursor SDK cleanup failed: ${cursorFailure(error).message}`,
        { cause: error },
      );
    }
  }
  if (failure) throw failure;
  if (cancelled) throw cancelFailure ?? new Error("Cursor review cancelled.");
  if (!result) throw new CursorReviewError("protocol", "Cursor returned no review.");
  await sendMessage(result);
}

// The dedicated worker has no work after disposal. Explicit exit avoids SDK idle
// timers delaying the CLI; the parent still verifies process-tree cleanup.
void main().then(
  () => process.exit(0),
  async (error: Error) => {
    await sendMessage({ kind: "error", ...cursorFailure(error) }).catch(() => undefined);
    process.exit(1);
  },
);
