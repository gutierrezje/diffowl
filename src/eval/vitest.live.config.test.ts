import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

it("fails the live eval command before Vitest starts when no model is set", async () => {
  const result = await execa(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "src/eval/vitest.live.config.mjs",
    ],
    { cwd: root, env: { DIFFOWL_EVAL_MODEL: " " }, reject: false },
  );

  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("requires a nonblank DIFFOWL_EVAL_MODEL");
}, 60_000);
