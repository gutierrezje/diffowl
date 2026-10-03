import { writeFile } from "node:fs/promises";
import { execa } from "execa";

const args = process.argv.slice(2);
JSON.parse(args[args.indexOf("--json-schema") + 1]);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.MOCK_CLAUDE_EVIDENCE) {
  await writeFile(
    process.env.MOCK_CLAUDE_EVIDENCE,
    JSON.stringify({ args, prompt, pid: process.pid }),
  );
}
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const repairing =
  prompt.includes("previous review document failed schema validation") &&
  prompt.includes("Synthetic local context");
const mode = process.env.MOCK_CLAUDE_MODE;
if (mode === "descendant" || mode === "descendant-pipe" || mode === "descendant-pipe-hang") {
  const child = execa(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: false,
    cleanup: false,
    reject: false,
    stdio: mode === "descendant" ? "ignore" : "inherit",
  });
  void child.catch(() => undefined);
  child.unref();
  await writeFile(process.env.MOCK_CLAUDE_EVIDENCE, String(child.pid));
}
const output =
  mode === "invalid" || (mode === "retry" && !repairing)
    ? { summary: "Incomplete review" }
    : { summary: repairing ? "Repaired review" : "Synthetic review", findings: [] };
emit({
  type: "system",
  subtype: "init",
  session_id: "claude-fixture-session",
  model: "claude-sonnet-fixture",
  tools: mode === "unsafe-startup" ? ["Read", "Bash"] : ["Read", "Glob", "Grep"],
  mcp_servers: [],
  plugins: [],
});
if (mode === "hang" || mode === "descendant-pipe-hang")
  await new Promise(() => setInterval(() => {}, 1_000));
if (process.env.MOCK_CLAUDE_MODE === "unsafe-tool")
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Edit", input: {} }] },
  });
if (mode === "mutation") await writeFile("sample.ts", "mutation\n");
if (mode === "fallback-model")
  emit({
    type: "assistant",
    message: { model: "claude-opus-fixture", content: [] },
  });
if (mode !== "missing-result")
  emit({
    type: "result",
    subtype: "success",
    is_error: mode === "authentication",
    result: mode === "authentication" ? "Login expired" : undefined,
    session_id: "claude-fixture-session",
    structured_output: output,
    modelUsage:
      mode === "fallback-model" || mode === "ambiguous-model"
        ? { "claude-sonnet-fixture": {}, "claude-opus-fixture": {} }
        : mode === "remapped-model"
          ? { "claude-opus-fixture": {} }
          : { "claude-sonnet-fixture": {} },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 3,
    },
    total_cost_usd: 0.001,
  });
if (mode === "after-result") emit({ type: "assistant", message: { content: [] } });
if (mode === "nonzero") process.exitCode = 7;
