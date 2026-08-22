import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const PackageMetadataSchema = z.object({
  files: z.array(z.string()).optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  repository: z.object({ type: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  bugs: z.object({ url: z.string().optional() }).optional(),
});

describe("npm package metadata", () => {
  it("defines the public package and release contract", async () => {
    const packageJson = PackageMetadataSchema.parse(
      JSON.parse(await readFile("package.json", "utf-8")),
    );

    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.engines?.node).toBe(">=22.14.0");
    expect(packageJson.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@types/better-sqlite3"]).toBeUndefined();
    expect(packageJson.scripts?.["check:runtime"]).toBe("node scripts/check-runtime.mjs");
    expect(packageJson.scripts?.prebuild).toBe("pnpm run check:runtime");
    expect(packageJson.scripts?.predev).toBe("pnpm run check:runtime");
    expect(packageJson.scripts?.pretest).toBe("pnpm run check:runtime");
    expect(packageJson.scripts?.pretypecheck).toBe("pnpm run check:runtime");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/gutierrezje/diffowl.git",
    });
    expect(packageJson.homepage).toBe("https://github.com/gutierrezje/diffowl#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/gutierrezje/diffowl/issues");
  });

  it("pins the local development runtime to the oldest supported Node version", async () => {
    await expect(readRuntimeVersion(".nvmrc")).resolves.toBe("22.14.0");
    await expect(readRuntimeVersion(".node-version")).resolves.toBe("22.14.0");
  });
});

async function readRuntimeVersion(path: string): Promise<string> {
  return (await readFile(path, "utf-8")).trim();
}
