import { defineConfig, mergeConfig } from "vitest/config";
import config from "../../vitest.config.mjs";

// The live test skips itself without a model, so a blank model would make this command
// "pass" without reaching a provider. Fail before Vitest starts instead.
if (!process.env["DIFFOWL_EVAL_MODEL"]?.trim()) {
  throw new Error(
    "pnpm run test:eval:live requires a nonblank DIFFOWL_EVAL_MODEL (provider/model).",
  );
}

export default mergeConfig(
  config,
  defineConfig({
    test: {
      include: ["src/eval/runner.integration.test.ts"],
      env: { DIFFOWL_EVAL_INTEGRATION: "1" },
    },
  }),
);
