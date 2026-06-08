import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("npm package metadata", () => {
  it("defines the public package and release contract", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf-8")) as {
      files?: string[];
      engines?: { node?: string };
      scripts?: { prepack?: string };
      repository?: { type?: string; url?: string };
      homepage?: string;
      bugs?: { url?: string };
    };

    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.engines?.node).toBe(">=20");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/gutierrezje/diffowl.git",
    });
    expect(packageJson.homepage).toBe("https://github.com/gutierrezje/diffowl#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/gutierrezje/diffowl/issues");
  });
});
