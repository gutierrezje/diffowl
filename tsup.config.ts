import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "cursor-worker": "src/cursor/worker.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  shims: true,
  external: ["node:sqlite", "@cursor/sdk"],
});
