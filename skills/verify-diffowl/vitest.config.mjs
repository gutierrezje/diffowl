import { defineConfig } from "vitest/config";
import { gitTestEnvironment } from "../../src/test/git-environment.mjs";

export default defineConfig({
  test: {
    env: gitTestEnvironment,
    fileParallelism: false,
    include: ["skills/verify-diffowl/control-diffowl.verification.mjs"],
  },
});
