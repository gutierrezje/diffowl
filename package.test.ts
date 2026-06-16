import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("npm package metadata", () => {
  it("defines the public package and release contract", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf-8")) as {
      files?: string[];
      engines?: { node?: string };
      scripts?: Record<string, string>;
      repository?: { type?: string; url?: string };
      homepage?: string;
      bugs?: { url?: string };
    };

    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.engines?.node).toBe(">=22.14.0 <23");
    expect(packageJson.scripts?.["check:native-runtime"]).toBe(
      "node scripts/check-native-runtime.mjs",
    );
    expect(packageJson.scripts?.prebuild).toBe("pnpm run check:native-runtime");
    expect(packageJson.scripts?.predev).toBe("pnpm run check:native-runtime");
    expect(packageJson.scripts?.pretest).toBe("pnpm run check:native-runtime");
    expect(packageJson.scripts?.pretypecheck).toBe("pnpm run check:native-runtime");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/gutierrezje/diffowl.git",
    });
    expect(packageJson.homepage).toBe("https://github.com/gutierrezje/diffowl#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/gutierrezje/diffowl/issues");
  });

  it("pins the editor and shell Node runtime to the native dependency ABI", async () => {
    await expect(readRuntimeVersion(".nvmrc")).resolves.toBe("22.14.0");
    await expect(readRuntimeVersion(".node-version")).resolves.toBe("22.14.0");
  });
});

async function readRuntimeVersion(path: string): Promise<string> {
  return (await readFile(path, "utf-8")).trim();
}
