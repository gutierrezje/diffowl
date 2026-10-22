import { appendFile, writeFile } from "node:fs/promises";
import { execa } from "execa";

const scenario = process.argv[2] ?? "success";
// The parent appends the bundled worker path; argv[3] is the explicit evidence slot.
const evidencePath = process.argv.length >= 5 ? process.argv[3] ?? "" : "";
let started = false;
let finished = false;

process.on("message", (message) => {
  if (!isRecord(message)) return;
  if (message.kind === "cancel") {
    void handleCancel().catch(() => {
      process.exitCode = 1;
    });
    return;
  }
  if (message.kind === "start" && !started) {
    started = true;
    void handleStart(message).catch(() => {
      process.exitCode = 1;
    });
  }
});

async function handleStart(message) {
  if (scenario === "hang-before-session") {
    if (evidencePath) await writeFile(evidencePath, "started\n");
    return;
  }
  await send({ kind: "runtime", version: "fixture-sdk-1" });
  await send({ kind: "session", id: "fixture-session" });
  await send({ kind: "turn", id: "fixture-run-1", requestId: "fixture-request-1", attempt: 1 });
  if (finished) return;

  if (scenario === "store" && evidencePath) {
    await writeFile(evidencePath, `${message.storeDirectory}\n`);
  }
  if (scenario === "env" && evidencePath) {
    await writeFile(evidencePath, `${JSON.stringify({
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      nodePath: process.env.NODE_PATH ?? null,
      testSentinel: process.env.TEST_CURSOR_SENTINEL ?? null,
      apiKey: process.env.CURSOR_API_KEY ?? null,
    })}\n`);
  }

  if (scenario === "mutate" && evidencePath) {
    await writeFile(evidencePath, "fixture mutation\n");
  }
  if (scenario === "unsafe") {
    await send({ kind: "tool", name: "shell", status: "running" });
    return;
  }
  if (scenario === "retry") {
    await send({ kind: "validation", outcome: "retry", attempt: 1 });
  }
  if (scenario === "malformed") {
    await send({ kind: "result", text: "FINAL_REVIEW_JSON\n{\"summary\":", sessionId: "fixture-session", effectiveModel: "composer-2.5", usage: null });
    await finish();
    return;
  }
  if (scenario === "after-result-nonzero") {
    await send({ kind: "result", text: validReview("after-result"), sessionId: "fixture-session", effectiveModel: "composer-2.5", usage: null });
    process.disconnect?.();
    process.exitCode = 7;
    return;
  }
  if (scenario === "after-result") {
    await send({ kind: "result", text: validReview("after-result"), sessionId: "fixture-session", effectiveModel: "composer-2.5", usage: null });
    await send({ kind: "activity" });
    await finish();
    return;
  }
  if (scenario === "lingering" && evidencePath) {
    const child = execa(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      cleanup: false,
      reject: false,
      stdio: "ignore",
    });
    void child.catch(() => undefined);
    child.unref();
    await writeFile(evidencePath, `${child.pid ?? ""}\n`);
  }
  if (scenario === "teardown") {
    await send({ kind: "result", text: validReview("teardown"), sessionId: "fixture-session", effectiveModel: "composer-2.5", usage: null });
    return;
  }
  if (scenario === "timeout") return;

  await send({ kind: "activity" });
  if (scenario === "retry") await send({ kind: "turn", id: "fixture-run-2", requestId: null, attempt: 2 });
  await send({ kind: "validation", outcome: "accepted", attempt: scenario === "retry" ? 2 : 1 });
  await send({
    kind: "result",
    text: validReview(scenario === "retry" ? "retried" : "fixture"),
    sessionId: "fixture-session",
    effectiveModel: "composer-2.5",
    usage: null,
  });
  await finish();
}

async function handleCancel() {
  if (finished) return;
  finished = true;
  await send({ kind: "error", category: "protocol", message: "fixture cancellation acknowledged" }).catch(() => undefined);
  await finish();
}

function validReview(summary) {
  return `FINAL_REVIEW_JSON\n${JSON.stringify({ summary, findings: [] })}`;
}

async function send(message) {
  if (process.send === undefined) return;
  await new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function finish() {
  finished = true;
  if (evidencePath) await appendFile(evidencePath, "finished\n").catch(() => undefined);
  if (process.disconnect !== undefined && process.connected) process.disconnect();
}

function isRecord(value) {
  return value !== null && value !== undefined && Object(value) === value;
}
