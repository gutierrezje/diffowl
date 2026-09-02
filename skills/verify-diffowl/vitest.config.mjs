import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["skills/verify-diffowl/control-diffowl.verification.mjs"],
  },
});
