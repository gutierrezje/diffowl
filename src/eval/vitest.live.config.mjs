import { defineConfig, mergeConfig } from "vitest/config";
import config from "../../vitest.config.mjs";

export default mergeConfig(
  config,
  defineConfig({
    test: {
      include: ["src/eval/runner.integration.test.ts"],
      env: { DIFFOWL_EVAL_INTEGRATION: "1" },
    },
  }),
);
